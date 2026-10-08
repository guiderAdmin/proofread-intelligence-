import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
const source = await fs.readFile(new URL("../src/lib/review-state.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { applyIssueGeometry, stabilizeIssueIds, createSerialWriter, mergeIssueReviews } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const issue = (uid, id, extra = {}) => ({ backendUid: uid, id, page: 4, originalText: "will Complete the figure.", suggestedText: "will complete the figure.", ...extra });

test("late box refinement preserves current findings and accepted/ignored decisions", () => {
  const current = [issue("upper", 1, { resolved: true }), issue("lower", 3, { ignored: true }), issue("new", 4)];
  const result = applyIssueGeometry(current, [issue("upper", 1, { bbox: { x: 3, y: 40, w: 20, h: 3 } }), issue("lower", 2, { bbox: { x: 3, y: 70, w: 20, h: 3 } }), issue("removed", 4)]);
  assert.deepEqual(result.map((item) => item.backendUid), ["upper", "lower", "new"]);
  assert.equal(result[0].resolved, true);
  assert.equal(result[1].ignored, true);
  assert.equal(result[1].bbox.y, 70);
  assert.equal(result[2].bbox, undefined);
});

test("polling keeps issue IDs stable when earlier pages gain new findings", () => {
  const result = stabilizeIssueIds([issue("new", 1), issue("upper", 2), issue("lower", 3)], [issue("upper", 8), issue("lower", 10)]);
  assert.deepEqual(result.map((item) => item.id), [11, 8, 10]);
});

test("identical quotes on different pages cannot receive each other's boxes", () => {
  const result = applyIssueGeometry([issue("same", 1, { page: 5 })], [issue("same", 1, { bbox: { x: 1, y: 1, w: 1, h: 1 } })]);
  assert.equal(result[0].bbox, undefined);
});

test("failed grounding removes a stale estimate while preserving the finding", () => {
  const result = applyIssueGeometry([issue("upper", 1, { bbox: { x: 3, y: 1, w: 80, h: 20 } })], [issue("upper", 1, { bboxSource: "unverified" })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].bbox, undefined);
  assert.equal(result[0].bboxSource, "unverified");
});

test("marks saves are serialized and each snapshot stays with its own book", async () => {
  const writes = [];
  let finishFirst;
  const write = createSerialWriter(async (snapshot) => {
    writes.push(snapshot);
    if (writes.length === 1) await new Promise((resolve) => { finishFirst = resolve; });
  });
  const first = write({ book: "A", marks: [1] });
  const second = write({ book: "A", marks: [1, 2] });
  const third = write({ book: "B", marks: [3] });
  await Promise.resolve();
  assert.deepEqual(writes, [{ book: "A", marks: [1] }]);
  finishFirst();
  await Promise.all([first, second, third]);
  assert.deepEqual(writes, [{ book: "A", marks: [1] }, { book: "A", marks: [1, 2] }, { book: "B", marks: [3] }]);
});

test("a failed marks save is reported without blocking later snapshots", async () => {
  const writes = [];
  const write = createSerialWriter(async (snapshot) => {
    writes.push(snapshot);
    if (snapshot === 1) throw new Error("network failure");
  });
  await assert.rejects(write(1), /network failure/);
  await write(2);
  assert.deepEqual(writes, [1, 2]);
});

test("stale polling cannot undo a decision even after its PATCH has completed", () => {
  const current = [issue("upper", 1, { resolved: true, ignored: false })];
  const snapshot = [issue("upper", 1, { resolved: false, ignored: false }), issue("new", 2)];
  const result = mergeIssueReviews(snapshot, current, new Map(), true);
  assert.equal(result[0].resolved, true);
  assert.equal(result.length, 2);
  assert.equal(mergeIssueReviews(snapshot, current, new Map(), false)[0].resolved, false);
});

test("polling preserves an in-flight reset or ignore with mutually exclusive flags", () => {
  const result = mergeIssueReviews([issue("upper", 1, { resolved: true })], [issue("upper", 1)], new Map([["upper", "dismissed"]]));
  assert.equal(result[0].resolved, false);
  assert.equal(result[0].ignored, true);
  const reset = mergeIssueReviews(result, result, new Map([["upper", "open"]]));
  assert.equal(reset[0].resolved, false);
  assert.equal(reset[0].ignored, false);
});
