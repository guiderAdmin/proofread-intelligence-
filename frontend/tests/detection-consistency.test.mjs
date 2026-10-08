import test from "node:test";
import assert from "node:assert/strict";
import { lintPageText } from "../src/server/services/linter.js";
import { mergeDetectedIssues, reconcileAnalysisIssues, commitReconciledAnalysis } from "../src/server/services/issue-reconciliation.js";
import { parseModelJson, parseAnalysisResponse, normalizeIssues, analysisOutputTokenLimit, isFatalAuthError } from "../src/server/services/gemini.js";
import { snapIssuesToLayout } from "../src/server/services/pdf.js";

const finding = (overrides = {}) => ({
  uid: "upper", type: "typography", severity: "minor", quote: "will Complete the figure.",
  suggestion: "will complete the figure.", explanation: "The verb is mid-sentence.",
  box: { xmin: 100, ymin: 100, xmax: 350, ymax: 125 }, boxSource: "pdf_text",
  source: "ai", confidence: 0.98, status: "open", textStart: 15, textEnd: 40,
  ...overrides,
});

function repeatedPage(lowercaseSecond = false) {
  const lines = ["Here, the part will Complete the figure.",
    `Here, the part will ${lowercaseSecond ? "complete" : "Complete"} the figure.`];
  const text = lines.join(" ");
  let offset = 0;
  const layout = lines.flatMap((line, lineIndex) => {
    let x = 100;
    return line.split(" ").map((str) => {
      const word = { str, xmin: x, ymin: 100 + lineIndex * 400, xmax: x + str.length * 8,
        ymax: 125 + lineIndex * 400, textStart: offset, textEnd: offset + str.length, source: "pdf_text" };
      x = word.xmax + 8;
      offset = word.textEnd + 1;
      return word;
    });
  });
  return { text, layout };
}

test("screenshot regression: both identical capitalized captions survive AI/linter merge", () => {
  const { text, layout } = repeatedPage();
  const lint = lintPageText({ text, pageNumber: 4, pageCount: 99 });
  assert.equal(lint.filter((issue) => issue.type === "typography").length, 2);
  assert.notEqual(lint[0].textStart, lint[1].textStart);
  const issues = mergeDetectedIssues([finding({ boxSource: "ai", textStart: undefined, textEnd: undefined })], lint);
  snapIssuesToLayout(issues, layout);
  const merged = mergeDetectedIssues(issues);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((issue) => issue.box.ymin).sort((a, b) => a - b), [100, 500]);
  assert.equal(new Set(merged.map((issue) => issue.uid)).size, 2);
});

test("a correctly lowercased second caption does not inherit the first correction", () => {
  const { text, layout } = repeatedPage(true);
  const lint = lintPageText({ text });
  const issues = mergeDetectedIssues([finding({ boxSource: "ai", textStart: undefined })], lint);
  snapIssuesToLayout(issues, layout);
  assert.equal(mergeDetectedIssues(issues).length, 1);
});

test("same text and correction at different positions remain independent", () => {
  const second = finding({ uid: "lower", textStart: 55, textEnd: 80,
    box: { xmin: 100, ymin: 500, xmax: 350, ymax: 525 } });
  assert.equal(mergeDetectedIssues([finding(), second]).length, 2);
  const unlocated = finding({ uid: "unlocated", textStart: undefined, boxSource: "unverified" });
  assert.equal(mergeDetectedIssues([finding(), unlocated]).length, 2);
});

test("equivalent minus glyphs merge only at the same measured occurrence and retain review decisions", () => {
  const reviewed = finding({ uid: "arrow", type: "number", quote: "+1", suggestion: "−1", status: "accepted" });
  const local = { ...reviewed, uid: "local", type: "inconsistency", suggestion: "-1", status: "open", source: "linter" };
  assert.equal(mergeDetectedIssues([reviewed], [local]).length, 1);
  assert.equal(mergeDetectedIssues([reviewed], [{ ...local, textStart: 55,
    box: { xmin: 100, ymin: 500, xmax: 150, ymax: 525 } }]).length, 2);
  const result = reconcileAnalysisIssues([reviewed], [local]);
  assert.equal(result.length, 1);
  assert.equal(result[0].uid, "arrow");
  assert.equal(result[0].status, "accepted");
});

test("multiple different corrections on one phrase are not conflated", () => {
  assert.equal(mergeDetectedIssues([finding(), finding({ uid: "other", suggestion: "will complete the figures." })]).length, 2);
});

test("overlapping AI rectangles cannot merge independent capitalization errors", () => {
  const shape = finding({ uid: "shape", quote: "This is a Shape pattern.", suggestion: "This is a shape pattern.",
    textStart: undefined, textEnd: undefined, boxSource: "ai",
    box: { xmin: 100, ymin: 100, xmax: 900, ymax: 150 } });
  const square = finding({ uid: "square", quote: "A Square has four sides.", suggestion: "A square has four sides.",
    textStart: undefined, textEnd: undefined, boxSource: "ai",
    box: { xmin: 100, ymin: 115, xmax: 900, ymax: 165 } });
  assert.equal(mergeDetectedIssues([shape, square]).length, 2);
  assert.equal(mergeDetectedIssues([shape, { ...shape, uid: "another-estimate" }]).length, 2);
  // Even measured rectangles cannot equate different phrases without offsets
  // identifying the precise changed character.
  assert.equal(mergeDetectedIssues([{ ...shape, boxSource: "pdf_text" }, { ...square, boxSource: "pdf_text" }]).length, 2);
});

test("different quote lengths merge only at the same absolute changed-text offset", () => {
  const full = finding({ textStart: 15, textEnd: 40 });
  const short = finding({ uid: "short", quote: "Complete", suggestion: "complete", textStart: 20, textEnd: 28 });
  assert.equal(mergeDetectedIssues([full, short]).length, 1);
  assert.equal(mergeDetectedIssues([full, { ...short, textStart: 60, textEnd: 68 }]).length, 2);
});

test("reruns retain omitted findings, stable identities and human decisions", () => {
  const firstAt = new Date("2026-10-07T00:00:00Z");
  const nextAt = new Date("2026-10-07T01:00:00Z");
  const upper = finding({ status: "accepted", firstDetectedAt: firstAt, lastDetectedAt: firstAt });
  const lower = finding({ uid: "lower", textStart: 55, textEnd: 80, status: "dismissed",
    box: { xmin: 100, ymin: 500, xmax: 350, ymax: 525 }, firstDetectedAt: firstAt, lastDetectedAt: firstAt });
  const newError = finding({ uid: "new", type: "punctuation", quote: "Heading :", suggestion: "Heading:", textStart: 90 });
  const next = reconcileAnalysisIssues([upper, lower], [finding({ uid: "fresh-model-id" }), newError], nextAt);
  assert.equal(next.length, 3);
  assert.equal(next[0].uid, "upper");
  assert.equal(next[0].status, "accepted");
  assert.equal(next[0].seenInLatestAnalysis, true);
  assert.equal(next[0].firstDetectedAt, firstAt);
  assert.equal(next[0].lastDetectedAt, nextAt);
  assert.equal(next[1].status, "dismissed");
  assert.equal(next[1].seenInLatestAnalysis, false);
  assert.equal(next[1].lastDetectedAt, firstAt);
  const cleanRerun = reconcileAnalysisIssues(next, [], new Date());
  assert.equal(cleanRerun.length, 3);
  assert.equal(cleanRerun[0].status, "accepted");
  assert.ok(cleanRerun.every((issue) => issue.seenInLatestAnalysis === false));
});

test("verified correction identity survives a changed textual category on reanalysis", () => {
  const accepted = finding({ uid: "reviewed", status: "accepted", type: "typography" });
  const relabeled = finding({ uid: "new-model-id", type: "inconsistency" });
  const result = reconcileAnalysisIssues([accepted], [relabeled]);
  assert.equal(result.length, 1);
  assert.equal(result[0].uid, "reviewed");
  assert.equal(result[0].status, "accepted");
  assert.equal(result[0].type, "inconsistency");
  assert.equal(reconcileAnalysisIssues([accepted], [{ ...relabeled, textStart: 55 }]).length, 2);
  assert.equal(reconcileAnalysisIssues([accepted], [{ ...relabeled, boxSource: "ai" }]).length, 2);
  assert.equal(reconcileAnalysisIssues([accepted], [{ ...relabeled, type: "image" }]).length, 2);
});

test("partial deterministic scan preserves earlier visibility before provider failure", () => {
  const result = reconcileAnalysisIssues([finding({ seenInLatestAnalysis: true })], [], new Date(), { markUnseen: false });
  assert.equal(result[0].seenInLatestAnalysis, true);
  assert.equal(result[0].status, "open");
});

test("optimistic commit retries concurrent decisions and preserves them", async () => {
  let page = { issueRevision: 0, issues: [finding()] };
  let attempts = 0;
  const result = await commitReconciledAnalysis({
    readCurrent: async () => structuredClone(page), detected: [finding({ uid: "new-id" })],
    commit: async (snapshot, issues) => {
      attempts += 1;
      if (attempts === 1) {
        // Simulate the atomic review PATCH landing after the worker's read.
        page.issues[0].status = "accepted";
        page.issueRevision += 1;
      }
      if (snapshot.issueRevision !== page.issueRevision) return null;
      page = { issueRevision: page.issueRevision + 1, issues };
      return page;
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.issues[0].status, "accepted");
  assert.equal(result.issues[0].uid, "upper");
});

test("a revoked analysis claim cannot commit a stale response", async () => {
  let writes = 0;
  const result = await commitReconciledAnalysis({ readCurrent: async () => null, detected: [finding()],
    commit: async () => { writes += 1; return {}; } });
  assert.equal(result, null);
  assert.equal(writes, 0);
});

test("commit contention is bounded and leaves existing findings untouched", async () => {
  const page = { issues: [finding({ status: "dismissed" })] };
  let attempts = 0;
  await assert.rejects(commitReconciledAnalysis({ readCurrent: async () => structuredClone(page), detected: [], maxAttempts: 3,
    commit: async () => { attempts += 1; return null; } }), /previous findings were preserved/);
  assert.equal(attempts, 3);
  assert.equal(page.issues[0].status, "dismissed");
});

test("malformed, missing and incomplete JSON cannot be treated as a clean page", () => {
  for (const text of ["", "No findings", "{}", '{"pageKind":"content"}', '{"pageKind":"content","issues":null}',
    '{"pageKind":"content","issues":[{}]}', '{"pageKind":"content","issues":[']) {
    assert.throws(() => parseModelJson(text), /INVALID_ANALYSIS_RESPONSE/);
  }
  assert.deepEqual(parseModelJson('```json\n{"pageKind":"content","issues":[]}\n```').issues, []);
  assert.throws(() => parseAnalysisResponse({ text: '{"pageKind":"content","issues":[]}',
    candidates: [{ finishReason: "MAX_TOKENS" }] }), /truncated or blocked/);
  assert.deepEqual(parseAnalysisResponse({ text: '{"pageKind":"content","issues":[]}',
    candidates: [{ finishReason: "STOP" }] }).issues, []);
});

test("zero confidence remains zero and invalid token configuration is bounded", () => {
  const result = normalizeIssues({ issues: [{ type: "typography", severity: "minor", quote: "Complete", suggestion: "complete",
    explanation: "Capitalization", box_2d: [100, 100, 125, 200], confidence: 0 }] });
  assert.equal(result[0].confidence, 0);
  const previous = process.env.GEMINI_MAX_OUTPUT_TOKENS;
  try {
    process.env.GEMINI_MAX_OUTPUT_TOKENS = "NaN";
    assert.equal(analysisOutputTokenLimit(), 8192);
    process.env.GEMINI_MAX_OUTPUT_TOKENS = "999999";
    assert.equal(analysisOutputTokenLimit(), 32768);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_MAX_OUTPUT_TOKENS;
    else process.env.GEMINI_MAX_OUTPUT_TOKENS = previous;
  }
});

test("physical PDF position alone does not produce a printed page-number error", () => {
  assert.equal(lintPageText({ text: "Read the instruction on Page 65. 61", pageNumber: 4, pageCount: 99 })
    .filter((issue) => issue.type === "page_number").length, 0);
});

test("activities and examples do not share a numbering sequence", () => {
  assert.equal(lintPageText({ text: "Example 1 Activity 1 Example 2 Activity 2" })
    .filter((issue) => issue.type === "examples").length, 0);
});

test("invalid provider credentials are fatal rather than retried for each page", () => {
  assert.equal(isFatalAuthError({ status: 401, message: "Unauthorized" }), true);
  assert.equal(isFatalAuthError(new Error("YOUR PROJECT HAS BEEN DENIED ACCESS.")), true);
  assert.equal(isFatalAuthError(new Error("403 PERMISSION_DENIED")), true);
  assert.equal(isFatalAuthError(new Error("429 RESOURCE_EXHAUSTED")), false);
});
