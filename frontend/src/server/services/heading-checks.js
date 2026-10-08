import crypto from "crypto";

/** Capitalise the first word of an evidenced heading, never body occurrences. */
export function lintHeadingLayout(items, { pageNumber = 1 } = {}) {
  const lines = new Map();
  for (const item of items || []) {
    const key = item.lineId ? `${item.blockId}:${item.paragraphId}:${item.lineId}` :
      `${Math.round(item.ymin/10)}:${item.xmin<500 ? "left":"right"}`;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(item);
  }
  const rows = [...lines.values()].map(words => {
    words.sort((a,b)=>a.xmin-b.xmin);
    return { words, text:words.map(w=>w.str).join(" "), y:Math.min(...words.map(w=>w.ymin)),
      height:Math.min(...words.map(w=>w.ymax-w.ymin)), x:words[0].xmin };
  });
  const heights = items.map(w=>w.ymax-w.ymin).filter(h=>h>0).sort((a,b)=>a-b);
  const median = heights[Math.floor(heights.length/2)] || 15;
  return rows.filter(row => {
    if (!/^[a-z][a-z]+(?:\s+[A-Za-z]+){0,4}$/.test(row.text)) return false;
    if(row.words.some(word=>word.source==="ocr_text" && word.confidence<.8))return false;
    const banner=row.words.every(word=>word.role==="heading");
    // Large isolated headings, or a matched pair of parallel title labels.
    const large = row.height > median*1.65 && row.words.length<=4;
    const paired = /^[a-z]+(?:\s+[A-Z][a-z]+){1,3}$/.test(row.text) && rows.some(other =>
      other!==row && /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$/.test(other.text) &&
      Math.abs(other.y-row.y)<35 && Math.abs(other.x-row.x)>180 && other.height>row.height*.55);
    const isolated = /^[a-z]+(?:\s+[A-Z][a-z]+){1,3}$/.test(row.text) &&
      !/^(?:and|or|the|of|in|to|is|by|a|an|with|for|my|your)\b/.test(row.text) &&
      items.filter(item => item.blockId === row.words[0].blockId).length === row.words.length;
    return banner || large || paired || isolated;
  }).map(row => ({
    uid:crypto.randomUUID(), type:"heading", severity:"minor", quote:row.text,
    suggestion:row.text[0].toUpperCase()+row.text.slice(1),
    explanation:"This standalone heading begins with a lowercase letter. Capitalise its first word consistently with the neighbouring headings.",
    source:"linter", status:"open", confidence:.94, boxSource:row.words.every(w=>w.source==="ocr_text") ? "ocr_text":"pdf_text",
    box:{ xmin:Math.min(...row.words.map(w=>w.xmin)), ymin:Math.min(...row.words.map(w=>w.ymin)),
      xmax:Math.max(...row.words.map(w=>w.xmax)), ymax:Math.max(...row.words.map(w=>w.ymax)) },
    textStart:row.words[0].textStart, textEnd:row.words.at(-1).textEnd,
  }));
}
