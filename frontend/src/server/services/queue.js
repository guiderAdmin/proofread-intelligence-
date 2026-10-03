/* eslint-disable */
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import Book from "../models/Book.js";
import Page from "../models/Page.js";
import QueueLock from "../models/QueueLock.js";
import { emit } from "./bus.js";
import { extractPageText, extractPageLayout, snapIssuesToLayout, renderPageJpeg, withPdf, extractSinglePagePdf } from "./pdf.js";
import { analyzePageImage, friendlyError, sleep, withRetry } from "./gemini.js";
import { extractBookStructure, getPageContextFromStructure } from "./structure.js";
import { getAgentKnowledgeForAnalysis } from "../../../feature/agentic-bot/server/knowledge.js";
import { uploadPageImage, deleteAllPageImages, deleteUploadObject, downloadPdfObject, tempPdfPath } from "../storage.js";

const state = {
  batchRunning: false,
  batchStartedAt: 0,
};
const workerOwner = `${process.pid}-${crypto.randomUUID()}`;
const workerLockKey = "proofdesk-global-ai-worker";

function batchSize() {
  return Math.max(1, Number(process.env.PAGE_BATCH || 1));
}

function getPageGap() {
  if (process.env.GEMINI_TIER === "free") return 12000;
  return Number(process.env.PAGE_GAP_MS || 0);
}

function getBatchGap() {
  if (process.env.GEMINI_TIER === "free") return 12000;
  return Number(process.env.BATCH_GAP_MS || 1000);
}

// One logical analysis can take a little over ten minutes in the worst case:
// four 50-second model attempts for each of three retries, plus backoff.  Do
// not requeue a page while that bounded work may still be in flight.
function pageProcessingTimeoutMs() {
  return Math.max(60_000, Number(process.env.PAGE_PROCESSING_TIMEOUT_MS || 15 * 60 * 1000));
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

async function safeSave(doc) {
  try {
    await doc.save();
    return true;
  } catch (err) {
    if (err?.name === "DocumentNotFoundError") return false;
    throw err;
  }
}

function uploadsDir() {
  return process.env.UPLOADS_DIR || os.tmpdir();
}

/**
 * Ensure the book PDF is available locally for processing.
 * On Vercel, the local file disappears between invocations, so we re-download
 * from Cloudinary using the stored cloudinaryPdfKey.
 */
async function ensureLocalPdf(book) {
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

  let status = current.status;
  
  // CRITICAL: Never automatically unpause a book just because a background worker finishes a page
  if (status !== "paused") {
    const processingCount = pages.filter((p) => p.status === "processing").length;
    if (!pendingLeft) {
      status = pages.length > 0 && failed === pages.length ? "error" : "done";
    } else if (processingCount > 0) {
      status = "processing";
    } else if (status === "done" || status === "error") {
      status = "queued";
    }
  }

  const book = await Book.findByIdAndUpdate(
    bookId,
    {
      stats,
      status,
      progress: {
        current: processing?.pageNumber || done,
        done,
        failed,
      },
      error: status === "error" ? "Every page failed to analyze." : undefined,
    },
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
    layoutNotes: p.layoutNotes,
    issues: p.issues || [],
    error: friendlyError(p.error),
    hasImage: Boolean(p.imagePath),
    tokensUsed: p.tokensUsed,
    analyzedAt: p.analyzedAt,
    updatedAt: p.updatedAt,
    textExtract: includeText ? p.textExtract : undefined,
    imageUrl: `/api/books/${p.bookId}/pages/${p.pageNumber}/image`,
  };
}

async function processOnePage(pageDoc) {
  const book = await Book.findById(pageDoc.bookId);
  if (!book || book.status === "paused") {
    pageDoc.status = "pending";
    await safeSave(pageDoc);
    return;
  }

  pageDoc.status = "processing";
  pageDoc.error = undefined;
  await safeSave(pageDoc);
  emit(book._id, "page", { page: serializePage(pageDoc) });
  await refreshBookStats(book._id);

  // Ensure PDF is available locally (downloads from Cloudinary if needed on Vercel)
  const pdfPath = await ensureLocalPdf(book);

  const scale = Number(process.env.RENDER_SCALE || 1.15);
  console.log(`[page ${pageDoc.pageNumber}] rendering`);
  let layoutItems = [];
  let pdfBytes = null;

  // Render to a unique temp path so parallel pages don't collide
  const tempImagePath = path.join(os.tmpdir(), `proofdesk_${book._id}_page_${pageDoc.pageNumber}.jpg`);

  await withPdf(pdfPath, async (doc) => {
    pageDoc.textExtract = await extractPageText(doc, pageDoc.pageNumber);
    layoutItems = await extractPageLayout(doc, pageDoc.pageNumber);
    await renderPageJpeg(doc, pageDoc.pageNumber, tempImagePath, scale);
  });

  // Extract pure PDF page for Gemini (bypassing Node canvas bugs)
  pdfBytes = await extractSinglePagePdf(pdfPath, pageDoc.pageNumber);

  // Upload JPEG to Cloudinary — this URL survives across serverless invocations
  const jpegBuffer = await fs.readFile(tempImagePath);
  await fs.unlink(tempImagePath).catch(() => {});
  const imageUrl = await uploadPageImage(jpegBuffer, String(book._id), pageDoc.pageNumber);
  pageDoc.imagePath = imageUrl; // https://res.cloudinary.com/...

  await safeSave(pageDoc);
  emit(book._id, "page", { page: serializePage(pageDoc) });

  const { expectedUnit, expectedChapter, tocSummary } = getPageContextFromStructure(
    book.structure,
    pageDoc.pageNumber
  );

  console.log(`[page ${pageDoc.pageNumber}] calling Gemini`);
  const agentKnowledge = await getAgentKnowledgeForAnalysis(book._id, pageDoc.pageNumber);
  const result = await withRetry(() =>
    analyzePageImage({
      pdfBytes,
      imagePath: tempImagePath, // only used as context label, file already deleted
      pageNumber: pageDoc.pageNumber,
      pageCount: book.pageCount,
      language: book.language,
      bookType: book.bookType,
      classLevel: book.classLevel,
      subject: book.subject,
      textExtract: pageDoc.textExtract,
      expectedUnit,
      expectedChapter,
      tocSummary,
      model: book.model,
      thinkingLevel: book.thinkingLevel,
      projectInstructions: book.proofreadingInstructions || "",
      knowledgeContext: agentKnowledge,
    })
  );

  snapIssuesToLayout(result.issues, layoutItems);

  pageDoc.pageKind = result.pageKind;
  pageDoc.layoutNotes = result.layoutNotes;
  pageDoc.issues = result.issues;
  pageDoc.tokensUsed = result.tokensUsed;
  pageDoc.status = "done";
  pageDoc.analyzedAt = new Date();
  if (!(await safeSave(pageDoc))) return;
  console.log(`[page ${pageDoc.pageNumber}] done (${result.issues.length} issues)`);

  emit(book._id, "page", { page: serializePage(pageDoc) });
  await refreshBookStats(book._id);
}

async function processOnePageSafe(page) {
  try {
    await processOnePage(page);
  } catch (err) {
    const msg = String(err?.message || err);
    // ENOENT = missing PDF or image file = non-retryable, don't loop forever
    const isMissingFile = err?.code === "ENOENT" || msg.includes("ENOENT") || msg.includes("no such file");
    // 403/PERMISSION_DENIED = API key revoked or project blocked = FATAL, stop immediately
    const isFatalAuth =
      (msg.includes("403") && msg.includes("PERMISSION_DENIED")) ||
      msg.includes("denied access") ||
      msg.includes("DENIED ACCESS") ||
      msg.includes("API key not valid") ||
      msg.includes("API_KEY_INVALID");
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
        /internal error/i.test(msg) ||
        err?.name === "DocumentNotFoundError");
    if (err?.name === "DocumentNotFoundError") return;
    // `withRetry` has already exhausted its bounded provider retries. Do not
    // silently put the page back into the queue: that creates an infinite,
    // potentially billable loop. A user can explicitly resume/reanalyse it.
    page.status = "error";
    page.error = friendlyError(msg);
    await safeSave(page);
    emit(page.bookId, "page", { page: serializePage(page) });
    await refreshBookStats(page.bookId);
    if (isFatalAuth) {
      console.error(`[page ${page.pageNumber}] FATAL AUTH ERROR: ${msg.slice(0, 140)}`);
    } else if (retryable) {
      console.warn(`[page ${page.pageNumber}] retries exhausted: ${msg.slice(0, 140)}`);
    } else {
      console.error(`[page ${page.pageNumber}]`, err);
    }
  }
}

async function claimBatch() {
  const paused = await Book.find({ status: "paused" }).select("_id");
  const pausedIds = paused.map((b) => b._id);
  
  // Find all books that currently have pending pages
  const activeBookIdsArr = await Page.distinct("bookId", { 
    status: "pending", 
    bookId: { $nin: pausedIds } 
  });
  
  if (!activeBookIdsArr.length) return [];
  
  // Shuffle the array to ensure perfectly fair round-robin distribution across batches
  activeBookIdsArr.sort(() => Math.random() - 0.5);

  const claimed = [];
  const activeBookIds = new Set();
  let bIdx = 0;
  
  // Round-robin: grab 1 page from each book in turn until we hit batchSize
  while (claimed.length < batchSize() && activeBookIdsArr.length > 0) {
    const bId = activeBookIdsArr[bIdx];
    const updated = await Page.findOneAndUpdate(
      { bookId: bId, status: "pending" },
      { $set: { status: "processing" }, $unset: { error: 1 } },
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

async function runBatches() {
  if (state.batchRunning) return;
  if (!(await acquireWorkerLease())) return;
  state.batchRunning = true;
  state.batchStartedAt = Date.now();
  try {
    for (;;) {
      const claimed = await claimBatch();
      if (!claimed.length) break;
      await renewWorkerLease();
      console.log(`Gemini batch: pages ${claimed.map((p) => p.pageNumber).join(" + ")}`);
      
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
        await Page.updateMany({ _id: { $in: toRevert } }, { $set: { status: "pending" } });
      }
      
      if (toProcess.length === 0) break;

      await Promise.allSettled(toProcess.map(page => processOnePageSafe(page)));
      
      await sleep(getBatchGap());
    }
  } catch (err) {
    console.error("batch loop", err);
  } finally {
    state.batchRunning = false;
    await releaseWorkerLease().catch(() => {});
    try {
      const leftover = await Page.exists({ status: "pending" });
      if (leftover) setTimeout(() => tick(), 1500);
    } catch (e) {
      // Ignore DB errors when checking for leftovers to prevent bubbling
    }
  }
}

export function tick() {
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
  const filter = allProcessing
    ? { status: "processing" }
    : {
        status: "processing",
        updatedAt: { $lt: new Date(Date.now() - pageProcessingTimeoutMs()) },
      };
  const res = await Page.updateMany(filter, {
    $set: { status: "pending" },
    $unset: { error: 1 },
  });
  if (res.modifiedCount) {
    console.log(`recovered ${res.modifiedCount} stuck page(s)`);
    const bookIds = await Page.distinct("bookId", { status: "pending" });
    await Book.updateMany(
      { _id: { $in: bookIds }, status: { $in: ["processing", "error"] } },
      { $set: { status: "queued" } }
    );
    setTimeout(() => tick(), 500);
  }
  return res.modifiedCount;
}

export async function enqueueBook(book) {
  const pages = [];
  for (let n = 1; n <= book.pageCount; n += 1) {
    pages.push({
      bookId: book._id,
      pageNumber: n,
      status: "pending",
    });
  }
  if (pages.length) await Page.insertMany(pages);

  book.status = "queued";
  book.progress = { current: 0, done: 0, failed: 0 };
  await book.save();

  // Run structure extraction asynchronously so it doesn't block the upload request
  if (book.filePath && book.filePath !== "pending") {
    withPdf(book.filePath, (doc) => extractBookStructure(doc))
      .then(async (structure) => {
        book.structure = structure;
        await book.save();
      })
      .catch((err) => {
        console.warn("structure extraction warning:", err?.message || err);
      });
  }

  // Wake up the background processing loop
  setTimeout(() => tick(), 500);
}

export async function pauseBook(bookId) {
  const book = await Book.findByIdAndUpdate(bookId, { status: "paused" }, { new: true });
  emit(bookId, "book", { book: serializeBook(book) });
  return book;
}

export async function resumeBook(bookId) {
  await Page.updateMany(
    { bookId, status: { $in: ["processing", "error"] } },
    { $set: { status: "pending" }, $unset: { error: 1 } }
  );
  const book = await Book.findByIdAndUpdate(bookId, { status: "queued" }, { new: true });
  emit(bookId, "book", { book: serializeBook(book) });

  // Wake up the background processing loop
  setTimeout(() => tick(), 500);

  return book;
}

export async function reanalyzePage(bookId, pageNumber) {
  const page = await Page.findOne({ bookId, pageNumber });
  if (!page) throw new Error("Page not found");
  page.status = "pending";
  page.error = undefined;
  page.issues = [];
  await page.save();
  await Book.findByIdAndUpdate(bookId, { status: "queued" });
  emit(bookId, "page", { page: serializePage(page) });

  // Wake up the background loop for the reanalyzed page
  setTimeout(() => tick(), 500);

  return page;
}

export async function removeBookFiles(bookId) {
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
