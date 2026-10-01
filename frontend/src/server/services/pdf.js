import "../node-polyfill.js";
import fs from "fs/promises";
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
  const data = new Uint8Array(await fs.readFile(filePath));
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
  const doc = await entry.promise;
  try {
    return await fn(doc);
  } finally {
    entry.refs -= 1;
    if (entry.refs <= 0) {
      entry.timeout = setTimeout(() => {
        pdfCache.delete(filePath);
        try {
          doc.destroy();
        } catch {
          /* ignore */
        }
      }, 60000); // Keep alive for 60 seconds
    }
  }
}

export async function getPageCount(filePath) {
  return withPdf(filePath, (doc) => doc.numPages);
}

export async function extractPageText(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items
    .map((item) => ("str" in item ? item.str : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function extractPageLayout(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const width = viewport.width;
  const height = viewport.height;

  const items = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const itemWidth = item.width;
    const itemHeight = item.height;
    
    const top = height - y - itemHeight;
    const bottom = height - y;
    
    items.push({
      str: item.str,
      xmin: (x / width) * 1000,
      ymin: (top / height) * 1000,
      xmax: ((x + itemWidth) / width) * 1000,
      ymax: (bottom / height) * 1000,
    });
  }
  return items;
}

export async function renderPageJpeg(doc, pageNumber, outPath, scale = 1.15) {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const maxSide = Number(process.env.MAX_PAGE_PX || 1000);
  const fit = maxSide / Math.max(base.width, base.height, 1);
  const viewport = page.getViewport({ scale: Math.min(scale, fit) });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({
    canvasContext: ctx,
    viewport,
    canvasFactory,
  }).promise;

  const quality = Number(process.env.JPEG_QUALITY || 62);
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

export function snapIssuesToLayout(issues, layoutItems) {
  if (!issues || !issues.length || !layoutItems || !layoutItems.length) return;
  
  let fullText = "";
  const charToItem = [];
  
  for (let i = 0; i < layoutItems.length; i++) {
    const item = layoutItems[i];
    const startIdx = fullText.length;
    fullText += item.str + " "; 
    for (let j = startIdx; j < fullText.length; j++) {
      charToItem[j] = i;
    }
  }
  
  const cleanStr = (s) => s.toLowerCase().replace(/[\s\W_]+/g, "");
  const targetFull = cleanStr(fullText);
  
  const cleanToFullMap = [];
  for (let i = 0; i < fullText.length; i++) {
    if (/[a-zA-Z0-9]/.test(fullText[i])) { 
       cleanToFullMap.push(i);
    }
  }

  for (const issue of issues) {
    // Gemini response boxes are normalized to `box` before this function runs.
    if (!issue.quote || !issue.box) continue;
    const cleanQuote = cleanStr(issue.quote);
    if (!cleanQuote) continue;
    
    const matches = [];
    let startPos = 0;
    while (true) {
      const idx = targetFull.indexOf(cleanQuote, startPos);
      if (idx === -1) break;
      
      const startFullIdx = cleanToFullMap[idx];
      const endFullIdx = cleanToFullMap[idx + cleanQuote.length - 1];
      
      if (startFullIdx !== undefined && endFullIdx !== undefined) {
        const startItemIdx = charToItem[startFullIdx];
        const endItemIdx = charToItem[endFullIdx];
        
        let minX = 1000, minY = 1000, maxX = 0, maxY = 0;
        for (let i = startItemIdx; i <= endItemIdx; i++) {
          const it = layoutItems[i];
          if (!it) continue;
          minX = Math.min(minX, it.xmin);
          minY = Math.min(minY, it.ymin);
          maxX = Math.max(maxX, it.xmax);
          maxY = Math.max(maxY, it.ymax);
        }
        if (minX <= maxX) {
          matches.push({ xmin: minX, ymin: minY, xmax: maxX, ymax: maxY });
        }
      }
      startPos = idx + 1;
    }
    
    if (matches.length > 0) {
       const ai = [issue.box.ymin, issue.box.xmin, issue.box.ymax, issue.box.xmax];
       const aiCenterY = (ai[0] + ai[2]) / 2;
       const aiCenterX = (ai[1] + ai[3]) / 2;
       
       let bestMatch = matches[0];
       let minDist = Infinity;
       
       for (const m of matches) {
          const mCenterY = (m.ymin + m.ymax) / 2;
          const mCenterX = (m.xmin + m.xmax) / 2;
          const dist = Math.sqrt(Math.pow(mCenterY - aiCenterY, 2) + Math.pow(mCenterX - aiCenterX, 2));
          if (dist < minDist) {
            minDist = dist;
            bestMatch = m;
          }
       }
       
       issue.box = {
         ymin: Math.max(0, bestMatch.ymin - 5),
         xmin: Math.max(0, bestMatch.xmin - 5),
         ymax: Math.min(1000, bestMatch.ymax + 5),
         xmax: Math.min(1000, bestMatch.xmax + 5),
       };
    }
  }
}
