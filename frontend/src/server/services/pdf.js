import { lintAlphabetSteps } from "./alphabet-checks.js";
import { bannerMask } from "./ocr-banners.js";
import "../node-polyfill.js";
import fs from "fs/promises";
import os from "os";
import crypto from "crypto";
import { ocrLanguage, recogniseImage } from "./ocr.js";

import { clampBox, contentText, layoutTranscript, findTextMatches, textContentWords, tokenizeForLocation, requiresLiteralMatch } from "../../lib/text-geometry.js";


import path from "path";
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.js";
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.js";

// PDF.js otherwise tries to dynamically import a worker beside a bundled
// Next.js chunk, which does not exist in standalone output. Registering the
// in-process worker keeps server-side parsing deterministic and self-contained.
if (!globalThis.pdfjsWorker) globalThis.pdfjsWorker = { WorkerMessageHandler };

class NapiCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = Math.max(1, Math.ceil(width));
    canvasAndContext.canvas.height = Math.max(1, Math.ceil(height));
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

const canvasFactory = new NapiCanvasFactory();

const pdfjsDir = path.join(process.cwd(), "node_modules", "pdfjs-dist");

function standardFontDataUrl() {
  return path.join(pdfjsDir, "standard_fonts") + path.sep;
}

function cMapUrl() {
  return path.join(pdfjsDir, "cmaps") + path.sep;
}

export async function openPdf(filePath) {
  const bytes=await fs.readFile(filePath);
  const data=new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const task = pdfjs.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
    canvasFactory,
    standardFontDataUrl: standardFontDataUrl(),
    cMapUrl: cMapUrl(),
    cMapPacked: true,
  });
  return task.promise;
}

const pdfCache = new Map();

export async function withPdf(filePath, fn) {
  let entry = pdfCache.get(filePath);
  if (!entry) {
    entry = { promise: openPdf(filePath), refs: 0, timeout: null };
    pdfCache.set(filePath, entry);
  }
  entry.refs += 1;
  if (entry.timeout) {
    clearTimeout(entry.timeout);
    entry.timeout = null;
  }
  let doc;
  try {
    doc = await entry.promise;
    return await fn(doc);
  } finally {
    entry.refs -= 1;
    if (!doc) {
      // Failed opens must not poison the cache or leak reference counts.
      if (pdfCache.get(filePath) === entry) pdfCache.delete(filePath);
    } else if (entry.refs <= 0) {
      entry.timeout = setTimeout(() => {
        if (pdfCache.get(filePath) === entry) pdfCache.delete(filePath);
        Promise.resolve().then(() => doc.destroy()).catch(() => {});
      }, 60000);
      entry.timeout.unref?.();
    }
  }
}

export async function getPageCount(filePath) {
  return withPdf(filePath, (doc) => doc.numPages);
}

const metricsContext = createCanvas(1, 1).getContext("2d");
const measureText = (value, style) => {
  metricsContext.font = `100px ${style.fontFamily || "sans-serif"}`;
  return metricsContext.measureText(value).width;
};

export async function extractPageText(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  return contentText(await page.getTextContent());
}

export async function extractPageLayout(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  return textContentWords(content, page.getViewport({ scale: 1 }), measureText).map(toLayoutItem);
}

function toLayoutItem(word) {
  return { str: word.text, xmin: word.x, ymin: word.y, xmax: word.x + word.width, ymax: word.y + word.height,
    textStart: word.textStart, textEnd: word.textEnd, source: word.source, confidence: word.confidence };
}

function layoutWords(items) {
  return items.map((item) => ({ text: item.str, x: item.xmin, y: item.ymin, width: item.xmax - item.xmin,
    height: item.ymax - item.ymin, textStart: item.textStart, textEnd: item.textEnd,
    source: item.source || "pdf_text", confidence: item.confidence,
    blockId: item.blockId, paragraphId: item.paragraphId, lineId: item.lineId }));
}

export async function renderPageJpeg(doc, pageNumber, outPath, scale = 1.15, options = {}) {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const configuredSide = Number(options.maxSide ?? process.env.MAX_PAGE_PX);
  const maxSide = Number.isFinite(configuredSide) && configuredSide > 0 ? Math.min(3200, Math.max(320, configuredSide)) : 1000;
  const fit = maxSide / Math.max(base.width, base.height, 1);
  const safeScale = Number.isFinite(scale) && scale > 0 ? Math.min(4, scale) : 1.15;
  const viewport = page.getViewport({ scale: Math.min(safeScale, fit) });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({
    canvasContext: ctx,
    viewport,
    canvasFactory,
  }).promise;

  const configuredQuality = Number(options.quality ?? process.env.JPEG_QUALITY);
  const quality = Number.isFinite(configuredQuality) && configuredQuality > 0 ? Math.min(100, configuredQuality) : 62;
  const jpeg = await canvas.encode("jpeg", quality);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, jpeg);
  return { width: canvas.width, height: canvas.height, bytes: jpeg.length };
}

export async function extractSinglePagePdf(filePath, pageNumber) {
  const { PDFDocument } = await import("pdf-lib");
  const pdfBytes = await fs.readFile(filePath);
  const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const outDoc = await PDFDocument.create();
  
  // pageNumber is 1-indexed in ProofDesk, pdf-lib is 0-indexed
  const [copiedPage] = await outDoc.copyPages(srcDoc, [pageNumber - 1]);
  outDoc.addPage(copiedPage);
  
  const pdfBytesOut = await outDoc.save();
  return Buffer.from(pdfBytesOut);
}

export function pageImagePath(uploadsDir, bookId, pageNumber) {
  return path.join(uploadsDir, String(bookId), `page-${pageNumber}.jpg`);
}

export function bookFilePath(uploadsDir, bookId, originalName) {
  const safe = path.basename(originalName).replace(/[^\w.\- ()[\]]+/g, "_");
  return path.join(uploadsDir, String(bookId), safe || "book.pdf");
}

const repeatedCorrectionTypes = new Set(["spelling", "grammar", "punctuation", "typography", "inconsistency", "wording"]);

function canRepeatCorrection(issue) {
  const before = tokenizeForLocation(issue.quote);
  const after = tokenizeForLocation(issue.suggestion);
  if (!repeatedCorrectionTypes.has(issue.type) || before.length < 2 || !after.length || issue.quote === issue.suggestion) return false;
  // A long rewrite may depend on surrounding context. Only propagate a local
  // edit within the same exact phrase (including capitalization/punctuation).
  const unchanged = before.filter((token, index) => token === after[index]).length;
  return before.length === after.length && unchanged >= before.length - 1 && unchanged / before.length >= 0.5;
}

const visualIssueTypes = new Set(["image", "alignment", "layout", "spacing", "overflow"]);
function isTextualIssue(issue) {
  return Boolean(issue.quote?.trim()) && !visualIssueTypes.has(issue.type);
}

export function snapIssuesToLayout(issues, layoutItems) {
  if (!Array.isArray(issues)) return;
  if (!layoutItems?.length) {
    for (const issue of issues) if (isTextualIssue(issue) && !["pdf_text", "ocr_text"].includes(issue.boxSource)) issue.boxSource = "unverified";
    return;
  }
  const words = layoutWords(layoutItems);
  const additions = [];
  for (const issue of issues) {
    if (!isTextualIssue(issue)) continue;
    const signedNumber = /^[+−-]\d+$/.test(String(issue.quote).trim());
    const corroborated = signedNumber ? lintAlphabetSteps(layoutItems).filter(candidate =>
      candidate.quote === issue.quote && candidate.suggestion.replace("−", "-") === String(issue.suggestion).replace("−", "-")) : [];
    if (corroborated.length && !Number.isFinite(issue.textStart)) {
      const [first, ...rest] = corroborated;
      Object.assign(issue, {box:first.box,boxSource:first.boxSource,textStart:first.textStart,textEnd:first.textEnd});
      for (const candidate of rest) additions.push({...issue,uid:crypto.randomUUID(),status:"open",
        box:candidate.box,boxSource:candidate.boxSource,textStart:candidate.textStart,textEnd:candidate.textEnd});
    }
    const allowNumeric = signedNumber || issue.source === "linter" && Number.isFinite(issue.textStart);
    const literalOnly = signedNumber || requiresLiteralMatch(issue.quote, issue.suggestion);
    const caseMatches = findTextMatches(words, issue.quote, { caseSensitive: true, allowNumeric, literalOnly });
    const allMatches = caseMatches.length || literalOnly ? caseMatches : findTextMatches(words, issue.quote, { allowNumeric });
    const literalMatches = allMatches.filter((match) => match.literalExact);
    const matches = literalMatches.length ? literalMatches : allMatches;
    if (!matches.length) {
      if (!["pdf_text", "ocr_text"].includes(issue.boxSource)) issue.boxSource = "unverified";
      continue;
    }
    let best;
    const hasOffset = Number.isFinite(issue.textStart);
    if (hasOffset) best = matches.find((match) => match.textStart === issue.textStart);
    if (hasOffset && !best) {
      // A deterministic occurrence offset is authoritative. Do not silently
      // move its finding onto a different repeated phrase.
      if (!["pdf_text", "ocr_text"].includes(issue.boxSource)) issue.boxSource = "unverified";
      continue;
    }
    const hintArea = issue.box ? (issue.box.xmax-issue.box.xmin)*(issue.box.ymax-issue.box.ymin) : Infinity;
    if (!best && issue.box && issue.boxSource !== "unverified" && (!signedNumber || hintArea < 100000)) {
      const centerX = (issue.box.xmin + issue.box.xmax) / 2, centerY = (issue.box.ymin + issue.box.ymax) / 2;
      best = [...matches].sort((a, b) => Math.hypot((a.box.xmin + a.box.xmax) / 2 - centerX, (a.box.ymin + a.box.ymax) / 2 - centerY) -
        Math.hypot((b.box.xmin + b.box.xmax) / 2 - centerX, (b.box.ymin + b.box.ymax) / 2 - centerY))[0];
    }
    if (!best && matches.length > 1 && !canRepeatCorrection(issue)) {
      issue.boxSource = "unverified";
      continue;
    }
    if (signedNumber && best && !hasOffset && matches.length > 1) {
      const centerX=(issue.box.xmin+issue.box.xmax)/2,centerY=(issue.box.ymin+issue.box.ymax)/2;
      const distances=matches.map(match=>Math.hypot((match.box.xmin+match.box.xmax)/2-centerX,(match.box.ymin+match.box.ymax)/2-centerY)).sort((a,b)=>a-b);
      if(distances[0]>80 || distances[1]-distances[0]<20) {issue.boxSource="unverified";continue;}
    }
    best ||= matches[0];
    const applyMatch = (target, match) => {
      target.box = match.box;
      target.boxSource = match.source;
      target.textStart = match.textStart;
      target.textEnd = match.textEnd;
    };
    applyMatch(issue, best);
    if (!canRepeatCorrection(issue)) continue;
    const exactCopies = findTextMatches(words, issue.quote, { caseSensitive: true }).filter((match) => match.literalExact);
    for (const match of exactCopies) {
      if (match.box.xmin === best.box.xmin && match.box.ymin === best.box.ymin) continue;
      const exists = [...issues, ...additions].some((candidate) => candidate.type === issue.type && candidate.quote === issue.quote && candidate.suggestion === issue.suggestion &&
        (Number.isFinite(match.textStart) && candidate.textStart === match.textStart || candidate.boxSource === match.source && candidate.box && Math.abs(candidate.box.xmin - match.box.xmin) < 1 && Math.abs(candidate.box.ymin - match.box.ymin) < 1));
      if (exists) continue;
      const copy = { ...issue, uid: crypto.randomUUID(), status: "open" };
      applyMatch(copy, match);
      additions.push(copy);
    }
  }
  issues.push(...additions);
}

/** Parse Tesseract's word-level TSV using the actual rendered image size. */
export function parseTesseractTsv(tsv, width, height) {
  const words = [];
  const uncertainWords = [];
  let offset = 0;
  if (!(width > 0 && height > 0)) return { text: "", layoutItems: [], uncertainWords };
  for (const row of String(tsv || "").split(/\r?\n/).slice(1)) {
    const columns = row.split("\t");
    if (columns.length < 12 || Number(columns[0]) !== 5) continue;
    const text = columns.slice(11).join("\t").replace(/\s+/g, " ").trim();
    const [left, top, itemWidth, itemHeight, confidence] = columns.slice(6, 11).map(Number);
    if (!text || ![left, top, itemWidth, itemHeight, confidence].every(Number.isFinite) || itemWidth <= 0 || itemHeight <= 0) continue;
    if (confidence < 35) { uncertainWords.push(text); continue; }
    const box = clampBox({ xmin: left / width * 1000, ymin: top / height * 1000,
      xmax: (left + itemWidth) / width * 1000, ymax: (top + itemHeight) / height * 1000 });
    if (!box) continue;
    words.push({ str: text, ...box, textStart: offset, textEnd: offset + text.length, source: "ocr_text", confidence: confidence / 100,
      blockId: columns[2], paragraphId: columns[3], lineId: columns[4] });
    offset += text.length + 1;
  }
  return { text: words.map((word) => word.str).join(" "), layoutItems: words, uncertainWords };
}

async function extractOcrEvidence(doc, pageNumber, options = {}) {
  if (process.env.OCR_ENABLED === "false") return { text: "", layoutItems: [], warning: "OCR is disabled; scanned text locations could not be verified." };
  let directory;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "proofdesk-ocr-"));
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(300 / 72, 3200 / Math.max(base.width, base.height)) });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvasFactory }).promise;
    const imagePath = path.join(directory, "page.png");
    await fs.writeFile(imagePath, await canvas.encode("png"));
    const configuredLanguage = ocrLanguage(options.language);
    const timeout = () => Math.min(process.env.VERCEL ? 15000:60000, options.deadlineAt ? Math.max(1,options.deadlineAt-Date.now()-10000):60000, Math.max(1000, Number(process.env.OCR_TIMEOUT_MS) || 30000));
    const result = parseTesseractTsv(await recogniseImage(imagePath, configuredLanguage, { timeout: timeout() }), canvas.width, canvas.height);
    const mergeWords=(additional,prefix)=> {
      let offset=result.text.length+1;
      for(const word of additional.layoutItems) {
        const duplicate=result.layoutItems.some(prior=> {
          const overlap=Math.max(0,Math.min(word.xmax,prior.xmax)-Math.max(word.xmin,prior.xmin))*Math.max(0,Math.min(word.ymax,prior.ymax)-Math.max(word.ymin,prior.ymin));
          return overlap/Math.max(1,Math.min((word.xmax-word.xmin)*(word.ymax-word.ymin),(prior.xmax-prior.xmin)*(prior.ymax-prior.ymin)))>.65;
        });
        if(duplicate)continue;
        result.layoutItems.push({...word,blockId:`${prefix}:${word.blockId}`,textStart:offset,textEnd:offset+word.str.length});
        offset+=word.str.length+1;
      }
      result.text=result.layoutItems.map(w=>w.str).join(" ");
      result.uncertainWords.push(...additional.uncertainWords);
    };
    try {
      mergeWords(parseTesseractTsv(await recogniseImage(imagePath,configuredLanguage,{timeout:timeout(),psm:11}),canvas.width,canvas.height),"sparse");
      const banners=bannerMask(canvas);
      if(banners) {
        const bannerPath=path.join(directory,"banners.png");await fs.writeFile(bannerPath,await banners.canvas.encode("png"));
        const recovered=parseTesseractTsv(await recogniseImage(bannerPath,configuredLanguage,{timeout:timeout(),psm:11}),canvas.width,canvas.height);
        recovered.layoutItems=recovered.layoutItems.filter(word=>word.confidence>=.8 && banners.bands.some(band=>
          word.xmin*canvas.width/1000>=band.left-2 && word.xmax*canvas.width/1000<=band.right+2 &&
          word.ymin*canvas.height/1000>=band.top-2 && word.ymax*canvas.height/1000<=band.bottom+2)).map(word=>({...word,role:"heading"}));
        mergeWords(recovered,"banner");
      }
    }catch{result.warning="Some isolated text could not be checked by OCR; visual coverage is required.";}
    result.structuredText = layoutTranscript(result.layoutItems);
    return { ...result, warning: result.layoutItems.length ? (result.warning || (result.uncertainWords.length ? "OCR contains uncertain words; verify the page visually before approving it." : "")) : "OCR did not recover confident words; scanned text locations remain unverified." };
  } catch (error) {
    const reason = error?.code === "ENOENT" ? "Tesseract is not installed on the analysis server" : error?.killed ? "OCR timed out" : "OCR could not read this page";
    return { text: "", layoutItems: [], warning: `${reason}; some text locations remain unverified.` };
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** A searchable footer/calendar does not cover a raster page's body. */
export function hasSubstantialNativeEvidence(text, items = []) {
  return (String(text).match(/\p{L}/gu) || []).length >= 120 && items.length >= 25;
}

/** Native text is preferred; scanned pages use a lossless OCR render. */
export async function extractPageEvidence(doc, pageNumber, options = {}) {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const text = contentText(content);
  const layoutItems = textContentWords(content, page.getViewport({ scale: 1 }), measureText).map(toLayoutItem);
  if (hasSubstantialNativeEvidence(text, layoutItems)) return { text, structuredText: layoutTranscript(layoutItems), layoutItems, source: "pdf_text", warning: "" };
  const ocr = await extractOcrEvidence(doc, pageNumber, options);
  return ocr.layoutItems.length ? { ...ocr, source: "ocr_text" } : { text, layoutItems, source: "pdf_text", warning: ocr.warning };
}

/** Supplement diagram/raster text only when a textual finding lacks a match. */
export async function groundPageIssues(doc, pageNumber, issues, layoutItems, options = {}) {
  const hintSources = new Map(issues.map((issue) => [issue, issue.boxSource]));
  snapIssuesToLayout(issues, layoutItems);
  const textual = issues.filter((issue) => isTextualIssue(issue) && tokenizeForLocation(issue.quote).length);
  const unmatched = textual.filter((issue) => !["pdf_text", "ocr_text"].includes(issue.boxSource));
  if (!unmatched.length || layoutItems.some((item) => item.source === "ocr_text")) return "";
  const ocr = await extractOcrEvidence(doc, pageNumber, options);
  if (ocr.layoutItems.length) {
    // Supplemental OCR uses a separate offset range from the native layer.
    const baseOffset = Math.max(0, ...layoutItems.map((item) => item.textEnd || 0)) + 1;
    const items = ocr.layoutItems.map((item) => ({ ...item, textStart: item.textStart + baseOffset, textEnd: item.textEnd + baseOffset }));
    // Native lookup failure removes verification, but the model hint is still
    // useful for disambiguating an OCR occurrence, never as OCR evidence.
    for (const issue of unmatched) if (hintSources.get(issue) === "ai") issue.boxSource = "ai";
    snapIssuesToLayout(unmatched, items);
    layoutItems.push(...items);
    // snap may append repeated occurrences to the subset.
    for (const issue of unmatched) if (!issues.includes(issue)) issues.push(issue);
  }
  return ocr.warning;
}
