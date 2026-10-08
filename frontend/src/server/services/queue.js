import { lintUnitLabels } from "./unit-label-checks.js";
import { lintAlphabetSteps } from "./alphabet-checks.js";
import { partitionGroundedFindings } from "./finding-evidence.js";
import { lintHeadingLayout } from "./heading-checks.js";
/* eslint-disable */
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import Book from "../models/Book.js";
import Page from "../models/Page.js";
import QueueLock from "../models/QueueLock.js";
import { emit } from "./bus.js";
import { extractPageEvidence, groundPageIssues, snapIssuesToLayout, renderPageJpeg, withPdf, extractSinglePagePdf } from "./pdf.js";
import { analyzePageOnce, friendlyError, isFatalAuthError, sleep } from "./gemini.js";
import { extractBookStructure, getPageContextFromStructure } from "./structure.js";
import { getAgentKnowledgeForAnalysis } from "../../../feature/agentic-bot/server/knowledge.js";
import {
  deleteChapterContexts,
  getChapterContextForAnalysis,
  getChapterForPage,
  refreshEvidenceIndex,
  buildAllChapterContexts,
} from "../../../feature/chapter-proofreader/index.js";
import { uploadPageImage, deleteAllPageImages, deleteUploadObject, downloadPdfObject, tempPdfPath } from "../storage.js";
import { HttpError } from "../validation.js";
import { commitReconciledAnalysis, mergeDetectedIssues } from "./issue-reconciliation.js";
import { lintPageText } from "./linter.js";

const state = {
  batchRunning: false,
  batchStartedAt: 0,
};
const workerOwner = `${process.pid}-${crypto.randomUUID()}`;
const workerLockKey = "proofdesk-global-ai-worker";

function batchSize() {
  const configured = Number(process.env.PAGE_BATCH || 1);
  return Number.isFinite(configured) ? Math.min(8, Math.max(1, Math.floor(configured))) : 1;
}

function getPageGap() {
  if (process.env.GEMINI_TIER === "free") return 12000;
  return Number(process.env.PAGE_GAP_MS || 0);
}

function getBatchGap() {
  if (process.env.GEMINI_TIER === "free") return 12000;
  return Number(process.env.BATCH_GAP_MS || 1000);
}

// One paid request per page analysis. Keep enough lease time for rendering and slow storage.
function pageProcessingTimeoutMs() {
  const configured = Number(process.env.PAGE_PROCESSING_TIMEOUT_MS || 15 * 60 * 1000);
  return Math.max(15 * 60 * 1000, Number.isFinite(configured) ? configured : 15 * 60 * 1000);
}

async function acquireWorkerLease() {
  const now = new Date();
  const lockedUntil = new Date(Date.now() + pageProcessingTimeoutMs() + 60_000);
  const existing = await QueueLock.findOneAndUpdate(
    {
      key: workerLockKey,
      $or: [{ lockedUntil: { $lte: now } }, { owner: workerOwner }],
    },
    { $set: { owner: workerOwner, lockedUntil } },
    { new: true }
  );
  if (existing) return true;
  try {
    await QueueLock.create({ key: workerLockKey, owner: workerOwner, lockedUntil });
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

async function renewWorkerLease() {
  await QueueLock.updateOne(
    { key: workerLockKey, owner: workerOwner },
    { $set: { lockedUntil: new Date(Date.now() + pageProcessingTimeoutMs() + 60_000) } }
  );
}

async function releaseWorkerLease() {
  await QueueLock.updateOne(
    { key: workerLockKey, owner: workerOwner },
    { $set: { lockedUntil: new Date(0) } }
  ).catch(() => {});
}

export function getQueueState() {
  return {
    batchRunning: state.batchRunning,
    batchSize: batchSize(),
    runningForMs: state.batchRunning ? Date.now() - state.batchStartedAt : 0,
  };
}

/**
 * Ensure the book PDF is available locally for processing.
 * On Vercel, the local file disappears between invocations, so we re-download
 * from Cloudinary using the stored cloudinaryPdfKey.
 */
export async function ensureLocalPdf(book) {
  // Prefer the stored filePath if it exists (local dev or same invocation)
  if (book.filePath && book.filePath !== "pending") {
    try {
      await fs.access(book.filePath);
      return book.filePath;
    } catch {
      // File is gone (Vercel ephemeral filesystem) — fall through to re-download
    }
  }
  const key = book.cloudinaryPdfKey;
  if (!key) throw new Error(`Book ${book._id} has no cloudinaryPdfKey and no local filePath`);
  const dest = tempPdfPath(book._id);
  try { await fs.access(dest); return dest; } catch { /* Cold instance: restore source. */ }
  await downloadPdfObject(key, book.pdfParts, dest);
  return dest;
}

export async function refreshBookStats(bookId) {
  const current = await Book.findById(bookId);
  if (!current) return null;
  const pages = await Page.find({ bookId }).lean();
  const issues = pages.flatMap((p) => p.issues || []);
  const done = pages.filter((p) => p.status === "done").length;
  const failed = pages.filter((p) => p.status === "error").length;
  const processing = pages.find((p) => p.status === "processing");
  const pendingLeft = pages.some((p) => p.status === "pending" || p.status === "processing");

  const stats = {
    issues: issues.length,
    critical: issues.filter((i) => i.severity === "critical").length,
    major: issues.filter((i) => i.severity === "major").length,
    minor: issues.filter((i) => i.severity === "minor").length,
    accepted: issues.filter((i) => i.status === "accepted").length,
    dismissed: issues.filter((i) => i.status === "dismissed").length,
  };

  const processingCount = pages.filter((p) => p.status === "processing").length;
  // Compute page-derived state independently of the snapshot's pause flag.
  // The atomic expression below preserves the *current* flag, including a
  // resume that arrived between our read and write.
  const status = !pendingLeft ? (pages.length > 0 && failed === pages.length ? "error" : "done")
    : processingCount > 0 ? "processing" : "queued";

  const book = await Book.findByIdAndUpdate(
    bookId,
    [{ $set: {
      stats: { $literal: stats },
      status: {
        $switch: {
          branches: [
            { case: { $in: ["$status", ["paused", "context_approval"]] }, then: "$status" },
            { case: { $and: [
                { $in: ["$status", ["done", "error"]] },
                { $in: [{ $literal: status }, ["queued", "processing"]] }
              ]}, then: "$status" }
          ],
          default: { $literal: status }
        }
      },
      progress: { $literal: {
        current: processing?.pageNumber || done,
        done,
        failed,
        indexed: pages.filter(page=>page.evidencePrepared).length,
      } },
      error: { $cond: [{ $eq: ["$status", "paused"] }, "$error",
        status === "error" ? "Every page failed to analyze." : "$$REMOVE"] },
    } }],
    { new: true }
  );

  emit(bookId, "book", {
    book: serializeBook(book),
  });
  return book;
}

export function serializeBook(book) {
  if (!book) return null;
  const b = book.toObject ? book.toObject() : book;
  return {
    id: String(b._id),
    title: b.title,
    originalName: b.originalName,
    classLevel: b.classLevel,
    subject: b.subject,
    pageCount: b.pageCount,
    language: b.language,
    bookType: b.bookType,
    model: b.model,
    thinkingLevel: b.thinkingLevel,
    proofreadingInstructions: b.proofreadingInstructions,
    status: b.status,
    progress: b.progress,
    stats: b.stats,
    chapterAnalysis: b.chapterAnalysis,
    customMarks: b.customMarks,
    error: b.error,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

export function serializePage(page, { includeText = false } = {}) {
  const p = page.toObject ? page.toObject() : page;
  return {
    id: String(p._id),
    bookId: String(p.bookId),
    pageNumber: p.pageNumber,
    status: p.status,
    pageKind: p.pageKind,
    chapterKey: p.chapterKey,
    chapterContextVersion: p.chapterContextVersion,
    layoutNotes: p.layoutNotes,
    issues: p.issues || [],
    error: friendlyError(p.error),
    hasImage: Boolean(p.imagePath),
    tokensUsed: p.tokensUsed,
    evidencePrepared:p.evidencePrepared,
    analyzedAt: p.analyzedAt,
    analysisModel: p.analysisModel,
    analysisWarnings: p.analysisWarnings || [],
    coverage:p.coverage,
    updatedAt: p.updatedAt,
    textExtract: includeText ? p.textExtract : undefined,
    imageUrl: `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/books/${p.bookId}/pages/${p.pageNumber}/image`,
  };
}

// Consecutive page failures per book. A lone bad page (e.g. malformed model
// JSON) must not stop the whole book, but a run of failures means the provider
// is down and continuing would only burn quota.
const MAX_CONSECUTIVE_FAILURES = Math.min(10,Math.max(1,Number(process.env.MAX_CONSECUTIVE_PAGE_FAILURES)||3));

/** Evidence preparation is a durable worker step with no model request. */
export async function prepareEvidencePage(pageDoc, book, {deadlineAt, loadEvidence} = {}) {
  const claimFilter={_id:pageDoc._id,status:"processing",analysisRunId:pageDoc.analysisRunId};
  const evidence=loadEvidence ? await loadEvidence() : await withPdf(await ensureLocalPdf(book),
    doc=>extractPageEvidence(doc,pageDoc.pageNumber,{language:book.language,deadlineAt}));
  const layout=evidence.layoutItems||[];
  const detected=[...lintPageText({text:evidence.text,pageNumber:pageDoc.pageNumber,pageCount:book.pageCount}),
    ...lintHeadingLayout(layout),...lintAlphabetSteps(layout),...lintUnitLabels(layout)];
  snapIssuesToLayout(detected,layout);
  const saved=await commitReconciledAnalysis({
    readCurrent:async()=>{const latest=await Page.findOne(claimFilter).lean();if(latest){snapIssuesToLayout(latest.issues,layout);latest.issues=mergeDetectedIssues(latest.issues);}return latest;},
    detected:partitionGroundedFindings(detected).verified,markUnseen:false,
    commit:(latest,issues)=>Page.findOneAndUpdate({...claimFilter,issueRevision:latest.issueRevision===undefined?{$exists:false}:latest.issueRevision},
      {$set:{issues,textExtract:evidence.text||"",structuredText:evidence.structuredText||evidence.text||"",textLayout:layout,
        uncertainWords:evidence.uncertainWords||[],evidencePrepared:true,evidenceIndexed:Boolean(layout.length),evidenceWarning:evidence.warning||"",
        analysisWarnings:evidence.warning?[evidence.warning]:[],status:"pending"},
        $inc:{issueRevision:1},$unset:{analysisRunId:1,processingHeartbeatAt:1}},{new:true})});
  return saved;
}

async function processOnePage(pageDoc,{deadlineAt}={}) {
  const book = await Book.findById(pageDoc.bookId);
  const claimFilter = { _id: pageDoc._id, status: "processing", analysisRunId: pageDoc.analysisRunId };
  if (!book) {
    await Page.deleteOne(claimFilter);
    return;
  }
  if (book.status === "paused") {
    await Page.updateOne(claimFilter, { $set: { status: "pending" }, $unset: { analysisRunId: 1, processingHeartbeatAt: 1 } });
    return;
  }

  emit(book._id, "page", { page: serializePage(pageDoc) });
  await refreshBookStats(book._id);

  if (!pageDoc.evidencePrepared) {
    const saved=await prepareEvidencePage(pageDoc,book,{deadlineAt});
    if(saved) {
      emit(book._id,"page",{page:serializePage(saved)});
      await refreshEvidenceIndex(book);
      await refreshBookStats(book._id);
    }
    return;
  }

  // Ensure PDF is available locally (downloads from Cloudinary if needed on Vercel)
  const pdfPath = await ensureLocalPdf(book);

  const scale = Number(process.env.RENDER_SCALE || 1.15);
  console.log(`[page ${pageDoc.pageNumber}] rendering`);
  let layoutItems = [];
  let pdfBytes = null;
  let imageBytes;
  let pageEvidence;
  const analysisWarnings = [];

  // Render to a unique temp path so parallel pages don't collide
  const tempImagePath = path.join(os.tmpdir(), `proofdesk_${book._id}_page_${pageDoc.pageNumber}_${pageDoc.analysisRunId}.jpg`);

  let imageUrl;
  try {
    await withPdf(pdfPath, async (doc) => {
      const evidence = {text:pageDoc.textExtract||"",structuredText:pageDoc.structuredText||pageDoc.textExtract||"",
        layoutItems:pageDoc.textLayout||[],uncertainWords:pageDoc.uncertainWords||[],warning:pageDoc.evidenceWarning||"",
        source:pageDoc.textLayout?.some(item=>item.source==="ocr_text")?"ocr_text":"pdf_text"};
      pageEvidence = evidence;
      pageDoc.textExtract = evidence.text;
      layoutItems = evidence.layoutItems;
      if (evidence.warning) analysisWarnings.push(evidence.warning);
      const pageViewport = (await doc.getPage(pageDoc.pageNumber)).getViewport({ scale: 1 });
      const fullPageScale = Math.min(2000 / Math.max(pageViewport.width, pageViewport.height), Math.max(scale, 1600 / Math.max(pageViewport.width, pageViewport.height)));
      await renderPageJpeg(doc, pageDoc.pageNumber, tempImagePath, fullPageScale, {maxSide:2000,quality:80});
    });
    if(pageEvidence.source!=="ocr_text" && (await fs.stat(pdfPath)).size<=32*1024*1024)
      pdfBytes = await extractSinglePagePdf(pdfPath, pageDoc.pageNumber);
    imageBytes = await fs.readFile(tempImagePath);
    imageUrl = await uploadPageImage(imageBytes, String(book._id), pageDoc.pageNumber);
  } finally {
    await fs.unlink(tempImagePath).catch(() => {});
  }
  const deterministicIssues = [...lintPageText({ text: pageDoc.textExtract, pageNumber: pageDoc.pageNumber, pageCount: book.pageCount }), ...lintHeadingLayout(layoutItems,{pageNumber:pageDoc.pageNumber}), ...lintAlphabetSteps(layoutItems),...lintUnitLabels(layoutItems)];
  snapIssuesToLayout(deterministicIssues, layoutItems);
  const rejectedLocal = deterministicIssues.filter(issue => !["pdf_text", "ocr_text"].includes(issue.boxSource));
  if (rejectedLocal.length) analysisWarnings.push(`${rejectedLocal.length} extracted-text candidates were withheld because their printed location could not be verified.`);
  const verifiedDeterministicIssues = deterministicIssues.filter(issue => ["pdf_text", "ocr_text"].includes(issue.boxSource));
  // Save local detections before a remote request: an outage or malformed
  // response must not erase findings that were already verified in page text.
  const savedEvidence = await commitReconciledAnalysis({
    readCurrent: () => Page.findOne(claimFilter).lean(), detected: verifiedDeterministicIssues, markUnseen: false,
    commit: (latest, issues) => Page.findOneAndUpdate({ ...claimFilter, updatedAt: latest.updatedAt,
      issueRevision: latest.issueRevision === undefined ? { $exists: false } : latest.issueRevision },
      { $set: { textExtract: pageDoc.textExtract, structuredText:pageEvidence.structuredText||pageDoc.textExtract, textLayout:layoutItems,uncertainWords:pageEvidence.uncertainWords||[],evidenceIndexed:Boolean(layoutItems.length),imagePath: imageUrl, analysisWarnings, issues, coverage:{complete:false,passes:0} },
        $inc: { issueRevision: 1 } }, { new: true }),
  });
  if (!savedEvidence) return; // A recovered/cancelled run cannot write over its successor.
  pageDoc = savedEvidence;
  emit(book._id, "page", { page: serializePage(pageDoc) });

  // Preserve native bookmarks/TOC support, but perform that work within the
  // awaited worker rather than delaying upload completion.
  if (pageDoc.pageNumber === 1 && !book.structure?.toc?.length) {
    try {
      const native = await withPdf(pdfPath, extractBookStructure);
      const structure = {...book.structure,
        toc:[...(book.structure?.toc||[]),...(native.toc||[])],
        units:[...new Set([...(book.structure?.units||[]),...(native.units||[])])],
        chapters:[...(book.structure?.chapters||[]),...(native.chapters||[]).map(chapter=>({
          ...chapter,confidence:chapter.source==="bookmark" ? .95 : .55}))]};
      await Book.updateOne({ _id: book._id }, { $set: { structure } });
      book.structure = structure;
    } catch {
      analysisWarnings.push("Front-matter structure could not be extracted; page evidence remains available.");
    }
  }

  const chapterKnowledge = await getChapterContextForAnalysis({
    book,
    pageNumber: pageDoc.pageNumber,
    pdfPath,
    allowBuild:true,deadlineAt,
  });

  const { expectedUnit, expectedChapter, tocSummary } = getPageContextFromStructure(book.structure,pageDoc.pageNumber);
  analysisWarnings.push(...(chapterKnowledge.warnings||[]));
  console.log(`[page ${pageDoc.pageNumber}] calling Gemini`);
  const agentKnowledge = await getAgentKnowledgeForAnalysis(book._id, pageDoc.pageNumber);
  let partialTokens=0;
  const result = await analyzePageOnce({
      pdfBytes,
      imageBytes,
      imagePath: tempImagePath,
      pageNumber: pageDoc.pageNumber,
      pageCount: book.pageCount,
      language: book.language,
      bookType: book.bookType,
      classLevel: book.classLevel,
      subject: book.subject,
      textExtract: pageEvidence.structuredText || pageDoc.textExtract,
      priorFindings:pageDoc.issues, deadlineAt,

      expectedUnit,
      expectedChapter,
      tocSummary,
      model: book.model,
      thinkingLevel: book.thinkingLevel,
      projectInstructions: book.proofreadingInstructions || "",
      knowledgeContext: agentKnowledge,
      chapterContext: chapterKnowledge.context,
    },{onPartialIssues:async (detected,partial)=>{
      await withPdf(pdfPath,doc=>groundPageIssues(doc,pageDoc.pageNumber,detected,layoutItems,{language:book.language,deadlineAt}));
      const grounded = partitionGroundedFindings(detected);
      if (grounded.pending.length) analysisWarnings.push(`${grounded.pending.length} first-pass language candidates require printed-text verification.`);
      const savedPartial=await commitReconciledAnalysis({readCurrent:()=>Page.findOne(claimFilter).lean(),detected:grounded.verified,markUnseen:false,
        commit:(latest,issues)=>Page.findOneAndUpdate({...claimFilter,issueRevision:latest.issueRevision===undefined?{$exists:false}:latest.issueRevision},
          {$set:{issues,coverage:{complete:false,passes:1},tokensUsed:(latest.tokensUsed||0)+(partial.tokensUsed||0)},$inc:{issueRevision:1}},{new:true})});
      if(!savedPartial) {const error=new Error("Analysis claim expired");error.name="DocumentNotFoundError";throw error;}
      partialTokens=partial.tokensUsed||0;
    }});

  const groundingWarning = await withPdf(pdfPath, (doc) =>
    groundPageIssues(doc, pageDoc.pageNumber, result.issues, layoutItems, { language: book.language,deadlineAt }));
  if (groundingWarning && !analysisWarnings.includes(groundingWarning)) analysisWarnings.push(groundingWarning);
  const groundedResult = partitionGroundedFindings(result.issues);
  if (groundedResult.pending.length) analysisWarnings.push(`${groundedResult.pending.length} language candidates were withheld because their quoted text could not be located. Visual review remains required.`);
  const analyzedAt = new Date();
  // Status PATCH requests can arrive during analysis. Reread the decisions,
  // then compare-and-set the revision so they cannot be lost between read/save,
  // even when two updates happen within the same millisecond.
  const completedPage = await commitReconciledAnalysis({
    readCurrent: () => Page.findOne(claimFilter).lean(),
    detected: mergeDetectedIssues(verifiedDeterministicIssues,groundedResult.verified),
    analyzedAt,
    commit: (latest, issues) => Page.findOneAndUpdate({ ...claimFilter, updatedAt: latest.updatedAt,
      issueRevision: latest.issueRevision === undefined ? { $exists: false } : latest.issueRevision }, {
      $set: { pageKind: result.pageKind, layoutNotes: result.layoutNotes, issues,
        tokensUsed: (latest.tokensUsed || 0) + (result.tokensUsed || 0) - (partialTokens || 0), status: "done", analyzedAt, analysisWarnings,
        chapterKey: chapterKnowledge.chapter?.chapterKey || latest.chapterKey || "",
        chapterContextVersion: chapterKnowledge.contextVersion || "", analysisModel: result.analysisModel, coverage:result.coverage,
        textLayout:layoutItems },
      $unset: { error: 1, analysisRunId: 1, processingHeartbeatAt: 1 },
      $inc: { issueRevision: 1 },
    }, { new: true }),
  });
  if (!completedPage) return;
  pageDoc = completedPage;
  console.log(`[page ${pageDoc.pageNumber}] done (${pageDoc.issues.length} issues)`);

  emit(book._id, "page", { page: serializePage(pageDoc) });
  await refreshBookStats(book._id);
}

async function processOnePageSafe(page,options={}) {
  try {
    await processOnePage(page,options);
    await Book.updateOne({_id:page.bookId},{$set:{analysisFailureCount:0}});
  } catch (err) {
    const msg = String(err?.message || err);
    // ENOENT = missing PDF or image file = non-retryable, don't loop forever
    const isMissingFile = err?.code === "ENOENT" || msg.includes("ENOENT") || msg.includes("no such file");
    // 403/PERMISSION_DENIED = API key revoked or project blocked = FATAL, stop immediately
    const isFatalAuth = isFatalAuthError(err);
    const retryable =
      !isMissingFile &&
      !isFatalAuth &&
      (msg.includes("429") ||
        msg.includes("RESOURCE_EXHAUSTED") ||
        msg.includes("timed out") ||
        msg.includes("DEADLINE") ||
        msg.includes("504") ||
        msg.includes("UNAVAILABLE") ||
        msg.includes("503") ||
        msg.includes("500") ||
        msg.includes("fetch failed") ||
        msg.includes("aborted") ||
        msg.includes("JSON_PARSE_ERROR") ||
        /internal error/i.test(msg) ||
        err?.name === "DocumentNotFoundError");
    if (err?.name === "DocumentNotFoundError") return;
    // The single paid attempt failed. Do not
    // silently put the page back into the queue: that creates an infinite,
    // potentially billable loop. A user can explicitly resume/reanalyse it.
    const failedPage = await Page.findOneAndUpdate(
      { _id: page._id, status: "processing", analysisRunId: page.analysisRunId },
      { $set: { status: "error", error: friendlyError(msg) }, $unset: { analysisRunId: 1, processingHeartbeatAt: 1 } }, { new: true });
    if (!failedPage) return;
    emit(page.bookId, "page", { page: serializePage(failedPage) });
    const failedBook=await Book.findByIdAndUpdate(page.bookId,{$inc:{analysisFailureCount:1}},{new:true});
    const failureCount=failedBook?.analysisFailureCount||1;
    const shouldPause = isFatalAuth || failureCount >= MAX_CONSECUTIVE_FAILURES;
    if (shouldPause) {
      const reason = isFatalAuth
        ? "Analysis paused because the Gemini API key was rejected. Fix the key, then resume."
        : retryable
          ? `Analysis paused after ${failureCount} consecutive failures because Gemini remained unavailable. Resume when the provider is stable.`
          : `Analysis paused after ${failureCount} consecutive page failures (last: page ${page.pageNumber}). Review the page error, then resume to retry.`;
      const pausedBook = await Book.findByIdAndUpdate(
        page.bookId,
        { $set: { status: "paused", error: reason } },
        { new: true }
      );
      if (pausedBook) emit(page.bookId, "book", { book: serializeBook(pausedBook) });
    }
    await refreshBookStats(page.bookId);
    if (isFatalAuth) {
      console.error(`[page ${page.pageNumber}] FATAL AUTH ERROR: ${msg.slice(0, 140)}`);
    } else if (retryable) {
      console.warn(`[page ${page.pageNumber}] single attempt failed: ${msg.slice(0, 140)}`);
    } else {
      console.error(`[page ${page.pageNumber}]`, err);
    }
  }
}

export async function claimBatch({bookId,limit=batchSize()}={}) {
  const active = await Book.find({ ...(bookId ? {_id:bookId}:{}), status:{$in:["queued","processing"]} }).select("_id");
  const activeIds=active.map(book=>book._id);

  // Find all books that currently have pending pages
  const activeBookIdsArr = await Page.distinct("bookId", {
    status: "pending",
    bookId: { $in: activeIds }
  });

  if (!activeBookIdsArr.length) return [];

  // Shuffle the array to ensure perfectly fair round-robin distribution across batches
  activeBookIdsArr.sort(() => Math.random() - 0.5);

  const claimed = [];
  const activeBookIds = new Set();
  let bIdx = 0;

  // Round-robin: grab 1 page from each book in turn until we hit batchSize
  while (claimed.length < limit && activeBookIdsArr.length > 0) {
    const bId = activeBookIdsArr[bIdx];
    const needsEvidence=await Page.exists({bookId:bId,status:"pending",evidencePrepared:{$ne:true}});
    const preparing = !needsEvidence && await Page.exists({bookId:bId,status:"processing",evidencePrepared:{$ne:true}});
    // The last preparation claim in a batch must finish before any review is claimed.
    if (preparing) {
      activeBookIdsArr.splice(bIdx,1);
      if(bIdx>=activeBookIdsArr.length)bIdx=0;
      continue;
    }
    
    if (!needsEvidence && !preparing) {
      const bookObj = await Book.findById(bId).select("chapterAnalysis status").lean();
      if (bookObj && bookObj.status !== "context_approval" && !bookObj.chapterAnalysis?.contextApproved) {
        // Evidence is prepared. Time to pause for context approval.
        await Book.updateOne({_id: bId}, { $set: { status: "context_approval" } });
        activeBookIdsArr.splice(bIdx, 1);
        if(bIdx>=activeBookIdsArr.length)bIdx=0;
        
        // Trigger background build of all chapters
        const bookDoc = await Book.findById(bId);
        const pdfPath = await ensureLocalPdf(bookDoc);
        buildAllChapterContexts(bookDoc, pdfPath).catch(err => console.error("Background context build failed:", err));
        
        continue;
      }
    }

    const updated = await Page.findOneAndUpdate(
      { bookId: bId, status: "pending",...(needsEvidence?{evidencePrepared:{$ne:true}}:{}) },
      { $set: { status: "processing", analysisRunId: crypto.randomUUID(), processingHeartbeatAt: new Date() }, $unset: { error: 1 } },
      { sort: { pageNumber: 1 }, new: true }
    );

    if (updated) {
      claimed.push(updated);
      activeBookIds.add(String(updated.bookId));
      bIdx = (bIdx + 1) % activeBookIdsArr.length;
    } else {
      // This book has no more pending pages, remove it from the round-robin pool
      activeBookIdsArr.splice(bIdx, 1);
      if (bIdx >= activeBookIdsArr.length) bIdx = 0;
    }
  }

  if (activeBookIds.size > 0) {
    await Book.updateMany(
      { _id: { $in: Array.from(activeBookIds) }, status: "queued" },
      { $set: { status: "processing" } }
    );
  }

  for (const page of claimed) {
    emit(page.bookId, "page", { page: serializePage(page) });
  }

  for (const bookId of activeBookIds) {
    await refreshBookStats(bookId);
  }

  return claimed;
}

async function runBatches({maxBatches=Infinity,bookId,limit=batchSize(),deadlineAt}={}) {
  if (state.batchRunning) return {busy:true,processed:0};
  let processed=0;
  // Reserve the in-process lock before the first await. Otherwise two ticks
  // can both acquire the same owner's distributed lease and run concurrently.
  state.batchRunning = true;
  state.batchStartedAt = Date.now();
  let leased = false;
  try {
    leased = await acquireWorkerLease();
    if (!leased) return {busy:true,processed:0};
    for (let batch=0;batch<maxBatches;batch++) {
      if(deadlineAt && Date.now()>deadlineAt-10000)break;
      const claimed = await claimBatch({bookId,limit});
      if (!claimed.length) break;
      await renewWorkerLease();
      console.log(`Worker batch: pages ${claimed.map((p) => p.pageNumber).join(" + ")}`);

      const activeBooks = await Book.find({
        _id: { $in: claimed.map(p => p.bookId) },
        status: { $ne: "paused" }
      }).select("_id");
      const activeBookIds = new Set(activeBooks.map(b => String(b._id)));

      const toProcess = [];
      const toRevert = [];

      for (const page of claimed) {
        if (activeBookIds.has(String(page.bookId))) {
          toProcess.push(page);
        } else {
          toRevert.push(page._id);
        }
      }

      if (toRevert.length > 0) {
        await Page.updateMany({ _id: { $in: toRevert }, status: "processing" },
          { $set: { status: "pending" }, $unset: { analysisRunId: 1, processingHeartbeatAt: 1 } });
      }

      if (toProcess.length === 0) break;

      // Long OCR/provider backoffs remain live work. Refresh the claim and
      // distributed lease so stale recovery cannot requeue a live request.
      const heartbeat = setInterval(() => {
        Promise.all([
          renewWorkerLease(),
          Page.updateMany({ status: "processing", analysisRunId: { $in: toProcess.map((page) => page.analysisRunId) } },
            { $set: { processingHeartbeatAt: new Date() } }, { timestamps: false }),
        ]).catch((error) => console.warn("analysis heartbeat failed:", error?.message || "Database unavailable"));
      }, 30_000);
      heartbeat.unref?.();
      try {
        await Promise.allSettled(toProcess.map(page => processOnePageSafe(page,{deadlineAt})));
      } finally {
        clearInterval(heartbeat);
      }
      processed+=toProcess.length;
      for (const bookId of activeBookIds) await refreshBookStats(bookId);

      const continuingBook = await Book.exists({
        _id: { $in: toProcess.map((page) => page.bookId) },
        status: { $in: ["queued", "processing"] },
      });
      if (continuingBook && batch+1<maxBatches) await sleep(getBatchGap());
    }
  } catch (err) {
    console.error("batch loop", err);
    throw err;
  } finally {
    state.batchRunning = false;
    if (leased) await releaseWorkerLease().catch(() => {});
    try {
      const paused = await Book.find({ status: "paused" }).select("_id").lean();
      const pausedIds = paused.map((book) => book._id);
      const leftover = await Page.exists({ status: "pending", bookId: { $nin: pausedIds } });
      if (leftover && maxBatches===Infinity && !process.env.VERCEL) setTimeout(() => tick(), 1500);
    } catch (e) {
      // Ignore DB errors when checking for leftovers to prevent bubbling
    }
  }
  return {busy:false,processed};
}

export async function runWorkerSlice({bookId}={}) {
  await recoverStalePages();
  return runBatches({maxBatches:1,limit:1,bookId,deadlineAt:Date.now()+280000});
}

export function tick() {
  if(process.env.VERCEL)return;
  // A second in-process worker can overlap an active Gemini request after a
  // timeout. Atomic page claims do not cancel that original request, so never
  // clear this lock on a timer. Stale recovery handles real process crashes.
  if (state.batchRunning) return;

  runBatches().catch((err) => {
    console.error("batch execution failed:", err?.message || err);
    state.batchRunning = false;
    // We intentionally DO NOT loop here. If there's an active proofread,
    // the frontend's 2-second poll will safely re-trigger tick() anyway.
    // This prevents runaway infinite loops when MongoDB is disconnected.
  });
}

export async function recoverStalePages({ allProcessing = false } = {}) {
  if (allProcessing && await QueueLock.exists({ key: workerLockKey, lockedUntil: { $gt: new Date() } })) return 0;
  const cutoff = new Date(Date.now() - pageProcessingTimeoutMs());
  const filter = allProcessing
    ? { status: "processing" }
    : {
        status: "processing",
        $or: [{ processingHeartbeatAt: { $lt: cutoff } },
          { processingHeartbeatAt: { $exists: false }, updatedAt: { $lt: cutoff } }],
      };
  const res = await Page.updateMany(filter, {
    $set: { status: "pending" },
    $unset: { error: 1, analysisRunId: 1, processingHeartbeatAt: 1 },
  });
  if (res.modifiedCount) {
    console.log(`recovered ${res.modifiedCount} stuck page(s)`);
    const bookIds = await Page.distinct("bookId", { status: "pending" });
    await Book.updateMany(
      { _id: { $in: bookIds }, status: { $in: ["processing", "error"] } },
      { $set: { status: "queued" } }
    );
    if(!process.env.VERCEL)setTimeout(() => tick(), 500);
  }
  return res.modifiedCount;
}

export async function enqueueBook(book) {
  // Immediately signal that processing has started so UI shows activity
  book.status = "processing";
  book.progress = { current: 0, done: 0, failed: 0 };
  await book.save();
  emit(book._id, "book", { book: serializeBook(book) });

  // Persist runnable pages immediately. Evidence and chapter boundaries are
  // indexed by the awaited page worker, never by the upload HTTP request.
  const pages = Array.from({ length: book.pageCount }, (_, index) => ({
    bookId: book._id, pageNumber: index + 1, status: "pending",
    textExtract: "", evidenceIndexed: false, chapterKey: "",
  }));
  if (pages.length) await Page.insertMany(pages);
  book.status = "queued";
  book.chapterAnalysis = { status: "pending", chapters: 0, tokensUsed: 0 };
  await book.save();
  emit(book._id, "book", { book: serializeBook(book) });

  // Wake up the background processing loop immediately
  if(!process.env.VERCEL)setTimeout(() => tick(), 0);
}

export async function pauseBook(bookId) {
  const book = await Book.findByIdAndUpdate(bookId, { status: "paused" }, { new: true });
  emit(bookId, "book", { book: serializeBook(book) });
  return book;
}

export async function resumeBook(bookId) {
  await Page.updateMany(
    // Running pages retain their claim. Resetting them would launch a second
    // analysis while the first request is still alive.
    { bookId, status: "error" },
    { $set: { status: "pending" }, $unset: { error: 1, analysisRunId: 1, processingHeartbeatAt: 1 } }
  );
  const resumed = await Book.findByIdAndUpdate(bookId, { $set: { status: "queued",analysisFailureCount:0 }, $unset: { error: 1 } }, { new: true });
  if (!resumed) throw new HttpError(404, "Book not found");
  const book = await refreshBookStats(bookId);
  emit(bookId, "book", { book: serializeBook(book) });

  // Wake up the background processing loop
  if(!process.env.VERCEL)setTimeout(() => tick(), 500);

  return book;
}

export async function reanalyzePage(bookId, pageNumber) {
  const page = await Page.findOneAndUpdate(
    { bookId, pageNumber, status: { $in: ["done", "error"] } },
    { $set: { status: "pending" }, $unset: { error: 1, analysisRunId: 1, processingHeartbeatAt: 1 } }, { new: true });
  if (!page) {
    const exists = await Page.exists({ bookId, pageNumber });
    if (!exists) throw new HttpError(404, "Page not found");
    throw new HttpError(409, "This page is already queued or being analyzed. Wait for it to finish before reanalyzing.");
  }
  await Book.findByIdAndUpdate(bookId, { status: "queued",analysisFailureCount:0 });
  emit(bookId, "page", { page: serializePage(page) });

  // Wake up the background loop for the reanalyzed page
  if(!process.env.VERCEL)setTimeout(() => tick(), 500);

  return page;
}

export async function removeBookFiles(bookId) {
  await deleteChapterContexts(bookId);
  // Delete all rendered page images from Cloudinary
  const book = await Book.findById(bookId).lean();
  if (book) {
    // Delete Cloudinary page images
    if (book.pageCount) {
      await deleteAllPageImages(String(bookId), book.pageCount).catch(() => {});
    }
    // Delete the source PDF from Cloudinary
    if (book.cloudinaryPdfKey) {
      await deleteUploadObject(book.cloudinaryPdfKey, book.pdfParts).catch(() => {});
    }
    // Clean up any local temp files
    const tmpPdf = tempPdfPath(bookId);
    await fs.unlink(tmpPdf).catch(() => {});
  }
}
