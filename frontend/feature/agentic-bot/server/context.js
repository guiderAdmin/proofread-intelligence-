const STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "are", "because", "been", "before", "being",
  "can", "could", "does", "for", "from", "have", "into", "its", "more", "page", "section",
  "should", "that", "the", "their", "then", "this", "what", "when", "where", "which", "with", "would",
]);

function terms(value) {
  return [...new Set(String(value || "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])]
    .filter((term) => !STOP_WORDS.has(term))
    .slice(0, 12);
}

function chunks(text, size = 700) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?।])\s+/);
  const result = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > size) {
      result.push(current.trim());
      current = "";
    }
    current += `${current ? " " : ""}${sentence}`;
  }
  if (current) result.push(current.trim());
  return result;
}

export function retrievePageContext({ text, query, selectedText, maxChars = 2400 }) {
  const cleanSelection = String(selectedText || "").replace(/\s+/g, " ").trim().slice(0, 1800);
  const needles = terms(`${query} ${cleanSelection}`);
  const ranked = chunks(text).map((chunk, index) => ({
    chunk,
    index,
    score: needles.reduce((score, term) => score + (chunk.toLowerCase().includes(term) ? 2 : 0), 0),
  })).sort((a, b) => b.score - a.score || a.index - b.index);

  const selected = [];
  let used = 0;
  if (cleanSelection) {
    selected.push(`User-selected text: ${cleanSelection}`);
    used += cleanSelection.length;
  }
  for (const item of ranked) {
    if (used + item.chunk.length > maxChars) continue;
    selected.push(item.chunk);
    used += item.chunk.length;
    if (selected.length >= 4) break;
  }
  return selected.join("\n\n").slice(0, maxChars);
}

export function compactIssues(pages, query, currentPage, limit = 60) {
  const needles = terms(query);
  return pages.flatMap((page) => (page.issues || []).map((issue) => ({
    page: page.pageNumber,
    type: issue.type,
    severity: issue.severity,
    quote: String(issue.quote || "").slice(0, 180),
    suggestion: String(issue.suggestion || "").slice(0, 180),
    explanation: String(issue.explanation || "").slice(0, 240),
    status: issue.status,
  }))).map((issue) => ({
    issue,
    score: (issue.page === currentPage ? 5 : 0) + needles.reduce((score, term) =>
      score + (JSON.stringify(issue).toLowerCase().includes(term) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score).slice(0, limit).map(({ issue }) => issue);
}
