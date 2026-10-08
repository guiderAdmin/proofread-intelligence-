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
    for (let offset = 0; offset < sentence.length; offset += size) {
      const part = sentence.slice(offset, offset + size);
      if (current.length + part.length > size) { result.push(current.trim()); current = ""; }
      current += `${current ? " " : ""}${part}`;
    }
  }
  if (current) result.push(current.trim());
  return result;
}

export function retrievePageContext({ text, query, selectedText, maxChars = 12000 }) {
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
    if (selected.length >= 18) break;
  }
  return selected.join("\n\n").slice(0, maxChars);
}

export function referencedIssueNumbers(query) {
  const match = String(query).match(/\bissues?\s*(?:numbers?|nos?\.?|#)?\s*((?:\d+\s*(?:(?:,|and|&|-)\s*)?)+)/i);
  return match ? [...new Set((match[1].match(/\d+/g) || []).map(Number))].slice(0, 30) : [];
}

export function compactIssues(pages, query, currentPage, options = {}) {
  const limit = typeof options === "number" ? options : (options.limit || 60);
  const mapping = typeof options === "object" ? options.sidebarIssueMap : null;
  const needles = terms(query), referenced = referencedIssueNumbers(query);
  const rows = pages.flatMap(page => (page.issues || []).map(issue => ({page:page.pageNumber, ...(issue.toObject ? issue.toObject() : issue)})));
  const byUid = new Map(rows.map((issue,index) => [String(issue.uid), { issue, sidebarNumber:index+1 }]));
  if (mapping !== undefined && mapping !== null) {
    if (!Array.isArray(mapping) || mapping.length > 5000) throw new Error("Invalid sidebar issue mapping");
    for (const entry of byUid.values()) entry.sidebarNumber = 0;
    const numbers = new Set(), uids = new Set();
    for (const row of mapping) {
      const entry = byUid.get(String(row?.uid));
      if (!entry || !Number.isSafeInteger(row.number) || row.number < 1 || row.number > 5000 ||
          row.page !== entry.issue.page || numbers.has(row.number) || uids.has(String(row.uid))) throw new Error("The issue list changed; refresh it before asking about its numbers.");
      numbers.add(row.number); uids.add(String(row.uid)); entry.sidebarNumber = row.number;
    }
  }
  return [...byUid.values()].map(({issue,sidebarNumber}) => ({
    uid: issue.uid, sidebarNumber, page: issue.page, type: issue.type, severity: issue.severity,
    quote:String(issue.quote||"").slice(0,600), suggestion:String(issue.suggestion||"").slice(0,600),
    explanation:String(issue.explanation||"").slice(0,600), status:issue.status,
    box:issue.box, boxSource:issue.boxSource, seenInLatestAnalysis:issue.seenInLatestAnalysis,
  })).map(issue => ({ issue, score: (referenced.includes(issue.sidebarNumber) ? 10000 : 0) +
    (issue.page===currentPage ? 5:0) + needles.reduce((n,term)=>n+Number(JSON.stringify(issue).toLowerCase().includes(term)),0)
  })).sort((a,b)=>b.score-a.score || a.issue.sidebarNumber-b.issue.sidebarNumber).slice(0,limit).map(row=>row.issue);
}

export function parseCompanionResponse(response) {
  const reason = response.candidates?.[0]?.finishReason;
  if (reason && reason !== "STOP") throw new Error("Assistant response was incomplete. Saved findings were preserved; retry your question.");
  let result;
  try { result=JSON.parse(response.text || ""); } catch { throw new Error("Assistant returned an invalid response; saved findings were preserved."); }
  if (!result || typeof result.answer !== "string" || !result.answer.trim() || !Array.isArray(result.observations) || result.observations.length>50) throw new Error("Assistant returned incomplete evidence.");
  return result;
}
