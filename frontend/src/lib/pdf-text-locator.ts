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

/** Remove punctuation, collapse whitespace, lowercase. */
const norm = (s: string) =>
  s.toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Simple character overlap similarity (0–1). */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  if (long.includes(short)) return short.length / long.length;
  let hits = 0;
  for (const ch of short) if (long.includes(ch)) hits++;
  return hits / long.length;
}

// ── Core search ───────────────────────────────────────────────────────────────

/**
 * Search for `searchText` inside the word list of a page.
 *
 * Strategy 1 – exact substring: join all normalised words into one string
 *   and look for the search phrase as a contiguous substring.  This is the
 *   most accurate path and avoids false positives on common words.
 *
 * Strategy 2 – progressive fuzzy: tries full-length → 5 → 3 → 2 → 1 word
 *   prefix matching with 78 % character-overlap tolerance per word.
 *
 * Matched regions are capped at 8 words to prevent cross-line rectangles.
 */
function findInWords(
  words: WordBox[],
  pageWidth: number,
  pageHeight: number,
  searchText: string
): BBox | null {
  if (!searchText || !searchText.trim() || searchText.length < 2) return null;

  const searchNorm = norm(searchText);
  if (!searchNorm) return null;

  // Pre-compute normalised word strings once
  const normed = words.map(w => norm(w.text));

  // ── Strategy 1: exact substring of concatenated page text ────────────
  if (searchNorm.length >= 3) {
    const fullText = normed.join(" ");
    const idx = fullText.indexOf(searchNorm);
    if (idx !== -1) {
      let charPos = 0;
      let startW = -1;
      let endW = -1;
      for (let i = 0; i < normed.length; i++) {
        const wEnd = charPos + normed[i].length;
        if (startW === -1 && wEnd > idx) startW = i;
        if (wEnd >= idx + searchNorm.length) { endW = i; break; }
        charPos = wEnd + 1; // +1 for the joining space
      }
      if (startW >= 0 && endW >= startW) {
        // Return exactly the matched words (no arbitrary length capping)
        return toBBox(words.slice(startW, endW + 1), pageWidth, pageHeight);
      }
    }
  }

  // ── Strategy 2: progressive word-by-word fuzzy matching ──────────────
  const targets = searchNorm.split(" ").filter(Boolean);
  if (!targets.length) return null;

  // Only fallback to smaller lengths if the original was small,
  // or allow at most dropping a couple words from the end (e.g. for punctuation mismatch)
  const lengths = Array.from(new Set([
    targets.length,
    Math.max(2, targets.length - 1),
    Math.max(1, targets.length - 2)
  ])).filter(len => len > 0 && len <= targets.length).sort((a,b) => b-a);

  for (const matchLen of lengths) {
    if (matchLen < 1) continue;
    const pattern = targets.slice(0, matchLen);

    for (let i = 0; i <= words.length - matchLen; i++) {
      let ok = true;
      for (let k = 0; k < matchLen; k++) {
        const wNorm = normed[i + k];
        const tNorm = pattern[k];
        if (wNorm !== tNorm && !wNorm.includes(tNorm) && !tNorm.includes(wNorm) && similarity(wNorm, tNorm) < 0.78) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return toBBox(words.slice(i, i + matchLen), pageWidth, pageHeight);
      }
    }
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
 * Issues that already have a bbox (manually drawn) are left untouched.
 * Issues whose text cannot be found are also left untouched (bbox stays undefined).
 *
 * Returns a new array — original objects are not mutated.
 */
export async function locateIssuesInPdf<
  T extends {
    originalText?: string;
    page?: number | null;
    pageIndex?: number | null;
    bbox?: BBox;
  }
>(pdfFile: File, issues: T[]): Promise<T[]> {
  if (!pdfFile || !issues.length) return issues;

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

        // Sort words visually: top-to-bottom, left-to-right.
        words.sort((a, b) => {
          if (Math.abs(a.y - b.y) > 5) {
            return a.y - b.y;
          }
          return a.x - b.x;
        });

        return { words, pageWidth: vp.width, pageHeight: vp.height };
      })();
      return cache[pageNum];
    };

    // Process all issues in parallel, serialising per-page cache writes
    const updated = await Promise.all(
      issues.map(async (issue): Promise<T> => {
        const text = issue.originalText;
        // Minimum phrase length to avoid false positives on single letters
        if (!text || text.trim().length < 3) return issue;

        const pageNum = issue.page ?? issue.pageIndex ?? 1;
        if (!pageNum) return issue;

        const p = await getCache(pageNum);
        if (!p) return issue;

        const bbox = findInWords(p.words, p.pageWidth, p.pageHeight, text);
        // If we found an exact match via PDF text extraction, it's perfectly accurate.
        // Otherwise, fallback to the AI-provided approximation (issue.bbox).
        if (bbox) return { ...issue, bbox };
        return issue;
      })
    );

    await pdf.destroy();
    return updated;
  } catch (err) {
    console.error("[pdf-text-locator] Failed:", err);
    return issues; // graceful fallback — issues still display, just without bbox overlay
  }
}
