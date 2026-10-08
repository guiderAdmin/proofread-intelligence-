/** Shared PDF/OCR word geometry. All boxes use a top-left origin. */
export function tokenizeForLocation(value, caseSensitive = false) {
  let text = String(value || "").normalize("NFKC")
    .replace(/([\p{L}])([\p{N}])/gu, "$1 $2")
    .replace(/([\p{N}])([\p{L}])/gu, "$1 $2");
  if (!caseSensitive) text = text.toLowerCase();
  return text.match(/[\p{L}\p{N}]+/gu) || [];
}

const literalText = (value) => String(value || "").replace(/\s+/g, " ").trim();

/** Case and punctuation edits need the actual erroneous printed characters. */
export function requiresLiteralMatch(quote, suggestion) {
  if (!suggestion || literalText(quote) === literalText(suggestion)) return false;
  return tokenizeForLocation(quote).join(" ") === tokenizeForLocation(suggestion).join(" ");
}

export function clampBox(box, limit = 1000) {
  if (!box || ![box.xmin, box.ymin, box.xmax, box.ymax].every(Number.isFinite)) return null;
  const xmin = Math.max(0, Math.min(limit, box.xmin));
  const ymin = Math.max(0, Math.min(limit, box.ymin));
  const xmax = Math.max(xmin, Math.min(limit, box.xmax));
  const ymax = Math.max(ymin, Math.min(limit, box.ymax));
  return xmax > xmin && ymax > ymin ? { xmin, ymin, xmax, ymax } : null;
}

export function contentText(content) {
  return content.items.map((item) => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
}

/** Transform every corner, including a rotated page or a rotated text run. */
export function textContentWords(content, viewport, measureText) {
  const words = [];
  let textOffset = 0;
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const text = String(item.str).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const itemOffset = textOffset;
    textOffset += text.length + 1;
    const [a, b, c, d, e, f] = item.transform;
    const fontHeight = Math.hypot(c, d) || Number(item.height) || Math.hypot(a, b);
    const baselineLength = Math.hypot(a, b);
    const runWidth = Math.abs(Number(item.width));
    if (![fontHeight, baselineLength, runWidth, e, f].every(Number.isFinite) || !fontHeight || !baselineLength || !runWidth) continue;
    const style = content.styles?.[item.fontName] || {};
    const ascent = Number.isFinite(style.ascent) ? style.ascent : 0.8;
    const descent = Number.isFinite(style.descent) ? style.descent : -0.2;
    const ux = a / baselineLength, uy = b / baselineLength;
    const vx = c / fontHeight, vy = d / fontHeight;
    const advance = (value) => {
      const measured = measureText?.(value, style);
      return Number.isFinite(measured) && measured > 0 ? measured : Array.from(value).reduce((sum, ch) => sum + (/[iljtf r1.,:;]/.test(ch) ? 0.5 : /[WMwm]/.test(ch) ? 1.4 : 1), 0);
    };
    const totalAdvance = advance(text);
    if (!totalAdvance) continue;
    for (const match of text.matchAll(/\S+/g)) {
      const start = match.index;
      const end = start + match[0].length;
      // Prefix advances preserve kerning. PDF's measured run width anchors both ends.
      const startRatio = Math.min(1, advance(text.slice(0, start)) / totalAdvance);
      const endRatio = Math.min(1, advance(text.slice(0, end)) / totalAdvance);
      const offsets = [startRatio * runWidth, endRatio * runWidth];
      const points = offsets.flatMap((offset) => [descent, ascent].map((extent) =>
        viewport.convertToViewportPoint(e + ux * offset + vx * fontHeight * extent, f + uy * offset + vy * fontHeight * extent)));
      const xs = points.map((point) => point[0]);
      const ys = points.map((point) => point[1]);
      const box = clampBox({ xmin: Math.min(...xs) / viewport.width * 1000, ymin: Math.min(...ys) / viewport.height * 1000,
        xmax: Math.max(...xs) / viewport.width * 1000, ymax: Math.max(...ys) / viewport.height * 1000 });
      if (!box) continue;
      words.push({ text: match[0], x: box.xmin, y: box.ymin, width: box.xmax - box.xmin, height: box.ymax - box.ymin,
        textStart: itemOffset + start, textEnd: itemOffset + end, source: "pdf_text" });
    }
  }
  return words;
}

export function wordOrder(words) {
  // Stable line clusters avoid the non-transitive comparator previously used.
  const sorted = words.map((word, index) => ({ ...word, index })).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const word of sorted) {
    const mid = word.y + word.height / 2;
    const line = lines.find((candidate) => Math.abs(candidate.mid - mid) <= Math.max(3, Math.min(candidate.height, word.height) * 0.55));
    if (line) line.words.push(word);
    else lines.push({ mid, height: word.height, words: [word] });
  }
  return lines.flatMap((line) => line.words.sort((a, b) => a.x - b.x || a.index - b.index));
}


/** Keep OCR paragraphs and spatial columns as separate reading streams. */
export function readingStreams(words) {
  const streams = [words, wordOrder(words)];
  const groups = new Map();
  for (const word of words) if (word.blockId) {
    const key = `${word.blockId}:${word.paragraphId || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(word);
  }
  for (const group of groups.values()) streams.push(wordOrder(group));
  // Recover columns even when the OCR engine put them in one paragraph.
  const votes = new Map([[500, 1]]);
  const ordered = wordOrder(words);
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1], b = ordered[i];
    const gap = b.x - a.x - a.width;
    if (Math.abs(a.y - b.y) < Math.max(a.height, b.height) && gap > 35) {
      const cut = Math.round((a.x + a.width + b.x) / 40) * 20;
      if (cut > 180 && cut < 820) votes.set(cut, (votes.get(cut) || 0) + 1);
    }
  }
  for (const [cut] of [...votes].sort((a,b) => b[1]-a[1]).slice(0, 6)) {
    streams.push(wordOrder(words.filter(w => w.x + w.width / 2 < cut)));
    streams.push(wordOrder(words.filter(w => w.x + w.width / 2 >= cut)));
  }
  return streams;
}

function continuousPhrase(words) {
  const start = words[0];
  return words.every((word, index) => {
    if (!index) return true;
    const prior = words[index - 1];
    const height = Math.max(word.height, prior.height, 3);
    const sameLine = Math.abs(word.y - prior.y) <= height * .65 &&
      word.x >= prior.x - 3 && word.x - prior.x - prior.width <= Math.max(50, height * 4);
    const wrapped = word.y > prior.y + height * .4 && word.y - prior.y <= height * 3.2 &&
      word.x >= start.x - 35 && word.x <= start.x + 65;
    const nativeAdjacent = word.source === "pdf_text" && prior.source === "pdf_text" &&
      Number.isFinite(prior.textEnd) && word.textStart >= prior.textEnd && word.textStart - prior.textEnd <= 3 &&
      Math.hypot(Math.max(0, word.x - prior.x - prior.width, prior.x - word.x - word.width),
        Math.max(0, word.y - prior.y - prior.height, prior.y - word.y - word.height)) <=
          Math.max(15, Math.min(prior.width, prior.height, word.width, word.height) * 4);
    return sameLine || wrapped || nativeAdjacent;
  });
}

/** OCR transcription follows blocks/paragraphs rather than mixed columns. */
export function layoutTranscript(items) {
  const words = items.map(item => ({ ...item, text: item.str ?? item.text,
    x: item.xmin ?? item.x, y: item.ymin ?? item.y,
    width: item.xmax !== undefined ? item.xmax - item.xmin : item.width,
    height: item.ymax !== undefined ? item.ymax - item.ymin : item.height }));
  const groups = new Map();
  for (const word of words) {
    const key = word.lineId ? `${word.blockId}:${word.paragraphId}:${word.lineId}` :
      `${word.blockId || "native"}:${Math.round(word.y / Math.max(5, word.height))}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(word);
  }
  return [...groups.values()].map(line => line.sort((a,b) => a.x-b.x).map(w=>w.text).join(" ")).join("\n");
}

function editSimilarity(a, b) {
  if (a === b) return 1;
  // Bounded rolling rows avoid allocating a quadratic matrix for long quotes.
  if (!a || !b || Math.max(a.length, b.length) > 100) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

/** Enumerate occurrences instead of silently selecting the first duplicate. */
export function findTextMatches(words, quote, options = {}) {
  const target = tokenizeForLocation(quote, options.caseSensitive);
  if (!target.length || (target.length === 1 && /^\d+$/.test(target[0]) && !options.allowNumeric)) return [];
  const matches = [], seen = new Set();
  for (const order of readingStreams(words)) {
    const tokens = order.flatMap((word, wordIndex) => tokenizeForLocation(word.text, options.caseSensitive).map((text) => ({ text, word, wordIndex })));
    for (let start = 0; start <= tokens.length - target.length; start += 1) {
      const slice = tokens.slice(start, start + target.length);
      const scores = target.map((text, index) => options.allowFuzzy ? editSimilarity(text, slice[index].text) : Number(text === slice[index].text));
      const score = scores.reduce((sum, value) => sum + value, 0) / scores.length;
      const exact = scores.every((value) => value === 1);
      if (!exact && !(options.allowFuzzy && target.length > 1 && score >= 0.9 && scores.every((value) => value >= 0.8))) continue;
      let firstWord = slice[0].wordIndex, lastWord = slice[slice.length - 1].wordIndex;
      let selected = order.slice(firstWord, lastWord + 1);
      const quoteLiteral = literalText(quote);
      const containsLiteral = (list) => literalText(list.map((word) => word.text).join(" ")).includes(quoteLiteral);
      let literalExact = containsLiteral(selected);
      // PDF text may place a colon or quotation mark in a separate item.
      // Include punctuation between words and adjacent punctuation requested
      // by the quote, so a punctuation fix cannot ground on a corrected phrase.
      if (!literalExact) {
        let minFirst = firstWord, maxLast = lastWord;
        while (minFirst > 0 && firstWord - minFirst < 3 && !tokenizeForLocation(order[minFirst - 1].text).length) minFirst -= 1;
        while (maxLast + 1 < order.length && maxLast - lastWord < 3 && !tokenizeForLocation(order[maxLast + 1].text).length) maxLast += 1;
        outer: for (let from = firstWord; from >= minFirst; from -= 1) {
          for (let to = lastWord; to <= maxLast; to += 1) {
            const candidate = order.slice(from, to + 1);
            if (containsLiteral(candidate)) { selected = candidate; literalExact = true; break outer; }
          }
        }
      }
      if (options.literalOnly && !literalExact) continue;
      // Content streams can interleave unrelated columns. Reject jumps that
      // could join separate diagram labels into a fabricated quote.
      if (!continuousPhrase(selected)) continue;
      const box = clampBox({ xmin: Math.min(...selected.map((word) => word.x)), ymin: Math.min(...selected.map((word) => word.y)),
        xmax: Math.max(...selected.map((word) => word.x + word.width)), ymax: Math.max(...selected.map((word) => word.y + word.height)) });
      if (!box) continue;
      const key = Object.values(box).map((value) => value.toFixed(3)).join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ box, exact, score, literalExact,
        textStart: selected[0].textStart, textEnd: selected[selected.length - 1].textEnd,
        source: selected.every((word) => word.source === "ocr_text") ? "ocr_text" : "pdf_text" });
    }
  }
  return matches.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.box.ymin - b.box.ymin || a.box.xmin - b.box.xmin);
}
