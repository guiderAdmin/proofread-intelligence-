/**
 * pdf-text-locator.ts
 *
 * Uses pdfjs-dist (already installed via react-pdf) to extract text positions
 * from each PDF page, then fuzzy-matches the issue's originalText to find its
 * exact bounding box when a persisted backend box is unavailable.
 *
 * Coordinate convention (output):
 *   { x, y, w, h }  — all in % of page dimensions, top-left origin.
 *   x=0,y=0 is top-left corner. x+w and y+h must be ≤ 100.
 */

export interface BBox {
  x: number; // left edge  (0-100)
  y: number; // top  edge  (0-100)
  w: number; // width      (0-100)
  h: number; // height     (0-100)
}

import { findTextMatches, textContentWords, tokenizeForLocation as tokenize, requiresLiteralMatch } from "./text-geometry.js";

interface WordBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  textStart?: number;
  textEnd?: number;
  source?: string;
}

interface PageCache {
  words: WordBox[];
  pageWidth: number;
  pageHeight: number;
}

export const tokenizeForLocation = (value: string): string[] => tokenize(value);

/** Select an occurrence using its saved location; return null when ambiguous. */
export function findInWords(
  words: WordBox[], pageWidth: number, pageHeight: number,
  searchText: string, hint?: BBox, suggestedText?: string,
): BBox | null {
  if (!searchText?.trim() || pageWidth <= 0 || pageHeight <= 0) return null;
  const normalized = words.map((word) => ({ ...word,
    x: word.x / pageWidth * 1000, y: word.y / pageHeight * 1000,
    width: word.width / pageWidth * 1000, height: word.height / pageHeight * 1000,
  }));
  const literalOnly = requiresLiteralMatch(searchText, suggestedText);
  const caseMatches = findTextMatches(normalized, searchText, { caseSensitive: true, literalOnly });
  const matches = caseMatches.length || literalOnly ? caseMatches : findTextMatches(normalized, searchText, { allowFuzzy: true });
  const exact = matches.filter((match) => match.exact);
  const candidates = exact.length ? exact : matches;
  if (!candidates.length || (!hint && candidates.length > 1)) return null;
  if (hint) candidates.sort((a, b) => {
    const distance = (match: typeof a) => Math.hypot((match.box.xmin + match.box.xmax) / 20 - hint.x - hint.w / 2,
      (match.box.ymin + match.box.ymax) / 20 - hint.y - hint.h / 2);
    return distance(a) - distance(b);
  });
  const box = candidates[0].box;
  return { x: box.xmin / 10, y: box.ymin / 10, w: (box.xmax - box.xmin) / 10, h: (box.ymax - box.ymin) / 10 };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load the PDF once and resolve the exact bounding box for every issue's
 * `originalText` on its respective page.
 *
 * Model boxes for textual issues are replaced only by grounded PDF text boxes.
 * If grounding fails, an unverified textual box is removed rather than shown
 * at an unrelated location. Inherently visual findings keep the model box.
 *
 * Returns a new array — original objects are not mutated.
 */
export async function locateIssuesInPdf<
  T extends {
    originalText?: string;
    suggestedText?: string;
    type?: string;
    page?: number | null;
    pageIndex?: number | null;
    bbox?: BBox;
    bboxSource?: "ai" | "pdf_text" | "ocr_text" | "unverified";
  }
>(pdfFile: File, issues: T[]): Promise<T[]> {
  if (!pdfFile || !issues.length) return issues;

  const removeBox = (issue: T): T => {
    const { bbox: _unverifiedBox, ...withoutBox } = issue;
    return { ...withoutBox, bboxSource: "unverified" } as T;
  };
  const visualTypes = new Set(["image", "alignment", "layout", "typography", "spacing", "overflow"]);
  const keepOrRemoveUnverified = (issue: T): T => {
    const textualTypography = String(issue.type || "").toLowerCase() === "typography" && Boolean(issue.originalText?.trim());
    if (issue.bboxSource !== "unverified" && !textualTypography && visualTypes.has(String(issue.type || "").toLowerCase())) return issue;
    if (issue.bboxSource === "pdf_text" || issue.bboxSource === "ocr_text") return issue;
    return removeBox(issue);
  };

  let pdf: { destroy: () => Promise<void> } | undefined;
  try {
    // Dynamic import keeps pdfjs out of SSR
    const pdfjsLib = await import("pdfjs-dist");

    // Use the worker bundled with the app (public/pdf.worker.min.js, pinned to
    // pdfjs-dist 3.11.174) so the API and worker versions always match.
    if (typeof window !== "undefined") {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
    }

    const arrayBuffer = await pdfFile.arrayBuffer();
    const pdfDocument = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer), isEvalSupported: false }).promise;
    pdf = pdfDocument;

    // Cache extracted text promises per page (1-indexed) so we don't reload for each issue concurrently
    const cache: Record<number, Promise<PageCache | null>> = {};

    const getCache = (pageNum: number): Promise<PageCache | null> => {
      if (cache[pageNum] !== undefined) return cache[pageNum];
      if (pageNum < 1 || pageNum > pdfDocument.numPages) return Promise.resolve(null);

      cache[pageNum] = (async () => {
        const page = await pdfDocument.getPage(pageNum);
        const vp   = page.getViewport({ scale: 1 });
        const tc   = await page.getTextContent();

        const context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
        const measureText = (value: string, style: { fontFamily?: string }) => {
          if (!context) return NaN;
          context.font = `100px ${style.fontFamily || "sans-serif"}`;
          return context.measureText(value).width;
        };
        const words: WordBox[] = textContentWords(tc, vp, measureText).map((word) => ({ ...word,
          x: word.x / 1000 * vp.width, y: word.y / 1000 * vp.height,
          width: word.width / 1000 * vp.width, height: word.height / 1000 * vp.height,
        }));

        return { words, pageWidth: vp.width, pageHeight: vp.height };
      })().catch((error) => {
        console.error(`[pdf-text-locator] Page ${pageNum} failed:`, error);
        return null;
      });
      return cache[pageNum];
    };

    // Process all issues in parallel, serialising per-page cache writes
    const updated = await Promise.all(
      issues.map(async (issue): Promise<T> => {
        // Server OCR boxes cannot be reconstructed from a scanned PDF text layer.
        if (issue.bboxSource === "ocr_text" && issue.bbox) return issue;
        const text = issue.originalText;

        // A single character is too ambiguous to ground safely on a page.
        if (!text || text.trim().length < 2) return keepOrRemoveUnverified(issue);

        const pageNum = issue.page ?? issue.pageIndex ?? 1;
        if (!pageNum) return keepOrRemoveUnverified(issue);

        const p = await getCache(pageNum);
        if (!p) return keepOrRemoveUnverified(issue);

        const bbox = findInWords(p.words, p.pageWidth, p.pageHeight, text, issue.bbox, issue.suggestedText);
        if (bbox) return { ...issue, bbox, bboxSource: "pdf_text" };
        if (p.words.length && requiresLiteralMatch(text, issue.suggestedText)) return removeBox(issue);

        // Gemini rectangles are valid fallbacks for visual findings, but they
        // must not masquerade as exact evidence for quoted text.
        return keepOrRemoveUnverified(issue);
      })
    );

    return updated;
  } catch (err) {
    console.error("[pdf-text-locator] Failed:", err);
    return issues.map(keepOrRemoveUnverified);
  } finally {
    await pdf?.destroy().catch(() => {});
  }
}
