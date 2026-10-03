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

interface WordBox {
  text: string;
  x: number;      // PDF-space left   (pts, bottom-left origin)
  y: number;      // PDF-space bottom (pts, bottom-left origin)
  width: number;
  height: number;
}

interface PageCache {
  words: WordBox[];
  pageWidth: number;
  pageHeight: number;
}

// ── String helpers ────────────────────────────────────────────────────────────

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
};

/** Make `scriptures1`, `scriptures 1`, and `scriptures¹` equivalent. */
export function tokenizeForLocation(value: string): string[] {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (char) => SUPERSCRIPT_DIGITS[char] || char)
    .replace(/([\p{L}])([\p{N}])/gu, "$1 $2")
    .replace(/([\p{N}])([\p{L}])/gu, "$1 $2")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

/** Levenshtein similarity, used only for complete multi-token phrases. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const matrix = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return 1 - matrix[a.length][b.length] / Math.max(a.length, b.length);
}

// ── Core search ───────────────────────────────────────────────────────────────

/**
 * Search for `searchText` inside the word list of a page.
 *
 * Search both PDF content order and geometry-derived reading order. Exact
 * complete-quote matches win; conservative fuzzy matching is limited to
 * complete multi-token quotes. Gemini's box only disambiguates duplicates.
 */
interface LocatedToken extends WordBox {
  normalized: string;
}

function tokenStream(words: WordBox[]): LocatedToken[] {
  return words.flatMap((word) =>
    tokenizeForLocation(word.text).map((normalized) => ({ ...word, normalized }))
  );
}

function visualWordOrder(words: WordBox[]): WordBox[] {
  return [...words].sort((a, b) => {
    const aMid = a.y + a.height / 2;
    const bMid = b.y + b.height / 2;
    const tolerance = Math.max(4, Math.min(a.height, b.height) * 0.8);
    return Math.abs(aMid - bMid) <= tolerance ? a.x - b.x : aMid - bMid;
  });
}

function bboxDistance(a: BBox, b?: BBox): number {
  if (!b) return 0;
  return Math.hypot(
    a.x + a.w / 2 - (b.x + b.w / 2),
    a.y + a.h / 2 - (b.y + b.h / 2),
  );
}

export function findInWords(
  words: WordBox[],
  pageWidth: number,
  pageHeight: number,
  searchText: string,
  hint?: BBox,
): BBox | null {
  if (!searchText || !searchText.trim() || searchText.length < 2) return null;
  const targets = tokenizeForLocation(searchText);
  if (!targets.length) return null;
  if (targets.length === 1 && /^\d+$/.test(targets[0])) return null;

  const exact: BBox[] = [];
  const fuzzy: Array<{ box: BBox; score: number }> = [];
  const seen = new Set<string>();
  for (const stream of [tokenStream(words), tokenStream(visualWordOrder(words))]) {
    for (let start = 0; start <= stream.length - targets.length; start += 1) {
      const slice = stream.slice(start, start + targets.length);
      const scores = targets.map((target, index) => similarity(target, slice[index].normalized));
      const isExact = scores.every((score) => score === 1);
      const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      const isFuzzy = targets.length >= 2 && scores.every((score) => score >= 0.72) && average >= 0.86;
      if (!isExact && !isFuzzy) continue;
      const box = toBBox(slice, pageWidth, pageHeight);
      if (!box) continue;
      const key = [box.x, box.y, box.w, box.h].map((value) => value.toFixed(3)).join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      if (isExact) exact.push(box);
      else {
        fuzzy.push({ box, score: average });
      }
    }
  }

  if (exact.length) return exact.sort((a, b) => bboxDistance(a, hint) - bboxDistance(b, hint))[0];
  if (fuzzy.length) {
    return fuzzy.sort((a, b) =>
      (b.score - a.score) || (bboxDistance(a.box, hint) - bboxDistance(b.box, hint))
    )[0].box;
  }
  return null;
}

/** Convert a list of WordBox entries to top-left-origin % BBox. */
function toBBox(words: WordBox[], pageWidth: number, pageHeight: number): BBox | null {
  if (!words.length || pageWidth < 1 || pageHeight < 1) return null;

  const left   = Math.min(...words.map(w => w.x));
  const top    = Math.min(...words.map(w => w.y));
  const right  = Math.max(...words.map(w => w.x + w.width));
  const bottom = Math.max(...words.map(w => w.y + w.height));

  // The coordinates are already mapped to viewport space (top-left origin).
  // So we just divide by width and height to get %.
  const x = Math.max(0,  (left  / pageWidth)  * 100);
  const y = Math.max(0,  (top   / pageHeight) * 100);
  const w = Math.min(100 - x, Math.max(0.8, ((right - left) / pageWidth) * 100));
  const h = Math.min(100 - y, Math.max(0.4, ((bottom - top) / pageHeight) * 100));

  // Guard against NaN from degenerate coordinates
  if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return null;

  return { x, y, w, h };
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
    type?: string;
    page?: number | null;
    pageIndex?: number | null;
    bbox?: BBox;
    bboxSource?: "ai" | "pdf_text";
  }
>(pdfFile: File, issues: T[]): Promise<T[]> {
  if (!pdfFile || !issues.length) return issues;

  const visualTypes = new Set(["image", "alignment", "layout", "typography", "spacing", "overflow"]);
  const keepOrRemoveUnverified = (issue: T): T => {
    if (visualTypes.has(String(issue.type || "").toLowerCase())) return issue;
    if (issue.bboxSource === "pdf_text") return issue;
    const { bbox: _unverifiedBox, ...withoutBox } = issue;
    return withoutBox as T;
  };

  try {
    // Dynamic import keeps pdfjs out of SSR
    const pdfjsLib = await import("pdfjs-dist");

    // Use the worker bundled with the app so locating remains available in
    // restricted and offline deployments.
    if (typeof window !== "undefined") {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        new URL("pdfjs-dist/build/pdf.worker.min.js", import.meta.url).toString();
    }

    const arrayBuffer = await pdfFile.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;

    // Cache extracted text promises per page (1-indexed) so we don't reload for each issue concurrently
    const cache: Record<number, Promise<PageCache | null>> = {};

    const getCache = (pageNum: number): Promise<PageCache | null> => {
      if (cache[pageNum] !== undefined) return cache[pageNum];
      if (pageNum < 1 || pageNum > pdf.numPages) return Promise.resolve(null);

      cache[pageNum] = (async () => {
        const page = await pdf.getPage(pageNum);
        const vp   = page.getViewport({ scale: 1 });
        const tc   = await page.getTextContent();

        const words: WordBox[] = [];
        for (const item of tc.items) {
          if (!("str" in item)) continue;
          const ti = item as any;
          const str = (ti.str as string).trim();
          if (!str) continue;

          // transform = [scaleX, skewX, skewY, scaleY, tx, ty]
          const tx_user = ti.transform[4] as number;
          const ty_user = ti.transform[5] as number;
          const itemW_user = (ti.width as number) || 0;
          const itemH_user = Math.abs(ti.transform[3] as number) || Math.abs(ti.transform[0] as number) || 10;

          // Map to viewport pixels (top-left origin) via the viewport transform.
          const [vx, vy] = vp.convertToViewportPoint(tx_user, ty_user);
          const [, vyTop] = vp.convertToViewportPoint(tx_user, ty_user + itemH_user);
          const [vxRight] = vp.convertToViewportPoint(tx_user + itemW_user, ty_user);

          const left  = Math.min(vx, vxRight);
          const right = Math.max(vx, vxRight);
          const top   = Math.min(vy, vyTop);
          const bottom = Math.max(vy, vyTop);
          const totalW = right - left;
          const h      = bottom - top;

          // Split multi-word text items into individual words so the fuzzy
          // matcher can align each search-word independently.
          const subWords = str.split(/\s+/).filter(Boolean);
          if (subWords.length <= 1 || totalW < 1) {
            words.push({ text: str, x: left, y: top, width: totalW, height: h });
          } else {
            const getCharWeight = (ch: string) => {
              const c = ch.toLowerCase();
              if (c === 'w' || c === 'm') return 1.4;
              if (c === 'i' || c === 'l' || c === 'j' || c === 't' || c === 'f' || c === 'r' || c === '1' || c === '.' || c === ',') return 0.5;
              if (c === ' ') return 0.6;
              if (ch >= 'A' && ch <= 'Z') return 1.2;
              return 1.0;
            };
            const getStringWeight = (s: string) => {
              let w = 0;
              for (const ch of s) w += getCharWeight(ch);
              return w;
            };
            
            const totalWeight = getStringWeight(str);
            let searchFrom = 0;
            for (const sw of subWords) {
              const charIdx = str.indexOf(sw, searchFrom);
              const prefixWeight = getStringWeight(str.substring(0, charIdx));
              const swWeight = getStringWeight(sw);
              
              const startFrac = prefixWeight / totalWeight;
              const endFrac   = (prefixWeight + swWeight) / totalWeight;
              
              words.push({
                text: sw,
                x: left + startFrac * totalW,
                y: top,
                width: Math.max((endFrac - startFrac) * totalW, 1),
                height: h,
              });
              searchFrom = charIdx + sw.length;
            }
          }
        }

        return { words, pageWidth: vp.width, pageHeight: vp.height };
      })();
      return cache[pageNum];
    };

    // Process all issues in parallel, serialising per-page cache writes
    const updated = await Promise.all(
      issues.map(async (issue): Promise<T> => {
        const text = issue.originalText;

        // A single character is too ambiguous to ground safely on a page.
        if (!text || text.trim().length < 2) return keepOrRemoveUnverified(issue);

        const pageNum = issue.page ?? issue.pageIndex ?? 1;
        if (!pageNum) return keepOrRemoveUnverified(issue);

        const p = await getCache(pageNum);
        if (!p) return keepOrRemoveUnverified(issue);

        const bbox = findInWords(p.words, p.pageWidth, p.pageHeight, text, issue.bbox);
        if (bbox) return { ...issue, bbox, bboxSource: "pdf_text" };

        // Gemini rectangles are valid fallbacks for visual findings, but they
        // must not masquerade as exact evidence for quoted text.
        return keepOrRemoveUnverified(issue);
      })
    );

    await pdf.destroy();
    return updated;
  } catch (err) {
    console.error("[pdf-text-locator] Failed:", err);
    return issues.map(keepOrRemoveUnverified);
  }
}
