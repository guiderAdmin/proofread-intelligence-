import crypto from "node:crypto";

const cleanText = (value) => String(value || "").normalize("NFKC").replace(/−/g, "-").replace(/\s+/g, " ").trim();
const hasOffset = (issue) => Number.isInteger(issue?.textStart) && issue.textStart >= 0;
const textualTypes = new Set(["spelling", "grammar", "punctuation", "page_number", "heading", "flow",
  "examples", "wording", "typography", "inconsistency", "number"]);
const hasVerifiedOffset = (issue) => hasOffset(issue) &&
  (["pdf_text", "ocr_text"].includes(issue?.boxSource) || issue?.source === "linter");

function correction(issue) {
  const quote = cleanText(issue?.quote);
  const suggestion = cleanText(issue?.suggestion);
  if (!quote || !suggestion || quote === suggestion) return null;
  let start = 0;
  while (start < quote.length && start < suggestion.length && quote[start] === suggestion[start]) start += 1;
  let endQuote = quote.length;
  let endSuggestion = suggestion.length;
  while (endQuote > start && endSuggestion > start && quote[endQuote - 1] === suggestion[endSuggestion - 1]) {
    endQuote -= 1;
    endSuggestion -= 1;
  }
  return { before: quote.slice(start, endQuote), after: suggestion.slice(start, endSuggestion), start };
}

function usableBox(issue) {
  // Model rectangles are estimates and often cover an entire paragraph. Their
  // overlap cannot prove that two findings refer to the same printed error.
  if (!["pdf_text", "ocr_text"].includes(issue?.boxSource)) return null;
  const box = issue?.box;
  if (!box || ![box.xmin, box.ymin, box.xmax, box.ymax].every(Number.isFinite)) return null;
  const width = box.xmax - box.xmin;
  const height = box.ymax - box.ymin;
  // A page-wide placeholder cannot identify an occurrence.
  if (width <= 0 || height <= 0 || width * height > 400_000) return null;
  return box;
}

/** Two findings are duplicates only when both the correction and occurrence agree. */
export function sameIssueOccurrence(left, right) {
  if (left?.uid && left.uid === right?.uid) return true;
  if (left?.type !== right?.type &&
      (!textualTypes.has(left?.type) || !textualTypes.has(right?.type) ||
       !hasVerifiedOffset(left) || !hasVerifiedOffset(right))) return false;
  const aChange = correction(left);
  const bChange = correction(right);
  const sameCorrection = aChange && bChange && aChange.before === bChange.before && aChange.after === bChange.after;
  const samePhrase = cleanText(left?.quote) === cleanText(right?.quote) && cleanText(left?.suggestion) === cleanText(right?.suggestion);
  if (!samePhrase && !sameCorrection) return false;
  if (!cleanText(left?.quote)) return false;
  if (hasOffset(left) && hasOffset(right)) {
    if (left.textStart + (sameCorrection ? aChange.start : 0) === right.textStart + (sameCorrection ? bChange.start : 0)) return true;
    if (left.type !== right.type || !samePhrase || !usableBox(left) || !usableBox(right)) return false;
  }
  // Different phrases may share a one-character correction (e.g. S -> s) in
  // different words. Only an absolute text offset can equate those changes.
  if (!samePhrase) return false;
  const a = usableBox(left);
  const b = usableBox(right);
  if (!a || !b) return false;
  const overlap = Math.max(0, Math.min(a.xmax, b.xmax) - Math.max(a.xmin, b.xmin)) *
    Math.max(0, Math.min(a.ymax, b.ymax) - Math.max(a.ymin, b.ymin));
  const smallerArea = Math.min((a.xmax - a.xmin) * (a.ymax - a.ymin), (b.xmax - b.xmin) * (b.ymax - b.ymin));
  return overlap / smallerArea >= 0.6;
}

export function mergeDetectedIssues(...groups) {
  const result = [];
  for (const issue of groups.flat()) {
    if (!issue) continue;
    const index = result.findIndex((existing) => sameIssueOccurrence(existing, issue));
    if (index < 0) {
      result.push({ ...issue });
    } else {
      // Prefer a measured text rectangle to a visual estimate, without changing
      // the identity or review decision of the first finding.
      const existing = result[index];
      const measured = ["pdf_text", "ocr_text"].includes(issue.boxSource);
      if (measured && !["pdf_text", "ocr_text"].includes(existing.boxSource)) {
        result[index] = { ...existing, box: issue.box, boxSource: issue.boxSource,
          textStart: issue.textStart, textEnd: issue.textEnd };
      }
    }
  }
  return result;
}

/** Reanalysis adds evidence; absence in a stochastic response is not resolution. */
export function reconcileAnalysisIssues(previous, detected, analyzedAt = new Date(), { markUnseen = true } = {}) {
  const old = (previous || []).map((issue) => issue.toObject ? issue.toObject() : { ...issue });
  const result = old.map((issue) => ({ ...issue, seenInLatestAnalysis: markUnseen ? false : issue.seenInLatestAnalysis !== false,
    firstDetectedAt: issue.firstDetectedAt || issue.lastDetectedAt || analyzedAt }));
  const claimed = new Set();
  for (const issue of mergeDetectedIssues(detected || [])) {
    const index = old.findIndex((prior, i) => !claimed.has(i) && sameIssueOccurrence(prior, issue));
    if (index >= 0) {
      claimed.add(index);
      result[index] = { ...old[index], ...issue, uid: old[index].uid,
        status: old[index].status || "open", seenInLatestAnalysis: true,
        firstDetectedAt: result[index].firstDetectedAt, lastDetectedAt: analyzedAt };
    } else {
      result.push({ ...issue, uid: issue.uid || crypto.randomUUID(), status: issue.status || "open",
        seenInLatestAnalysis: true, firstDetectedAt: analyzedAt, lastDetectedAt: analyzedAt });
    }
  }
  return result;
}

/** Retry an optimistic commit using the newest human decisions after a conflict. */
export async function commitReconciledAnalysis({ readCurrent, commit, detected, analyzedAt = new Date(), maxAttempts = 8, markUnseen = true }) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const latest = await readCurrent();
    if (!latest) return null; // Deleted page or revoked analysis claim.
    const saved = await commit(latest, reconcileAnalysisIssues(latest.issues, detected, analyzedAt, { markUnseen }));
    if (saved) return saved;
  }
  throw new Error("Page changed repeatedly during analysis; previous findings were preserved. Reanalyze the page to retry.");
}
