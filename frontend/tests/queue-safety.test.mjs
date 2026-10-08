import test from "node:test";
import assert from "node:assert/strict";
import Book from "../src/server/models/Book.js";
import Page from "../src/server/models/Page.js";
import QueueLock from "../src/server/models/QueueLock.js";
import { reanalyzePage, resumeBook, recoverStalePages } from "../src/server/services/queue.js";

test("reanalyzing a finished page retains earlier findings and review decisions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldIssue = { uid: "upper", status: "accepted", quote: "will Complete the figure." };
  const page = { _id: "page", bookId: "book", pageNumber: 4, status: "done", issues: [oldIssue] };
  t.mock.method(Page, "findOneAndUpdate", async (filter, update) => {
    assert.deepEqual(filter.status, { $in: ["done", "error"] });
    assert.equal(update.$set.status, "pending");
    assert.equal(update.$set.issues, undefined);
    assert.equal(update.$unset.issues, undefined);
    return { ...page, status: "pending" };
  });
  t.mock.method(Book, "findByIdAndUpdate", async () => ({}));
  const queued = await reanalyzePage("book", 4);
  assert.deepEqual(queued.issues, [oldIssue]);
  assert.equal(queued.issues[0].status, "accepted");
});

test("a queued or running page cannot be requeued while its provider request is live", async (t) => {
  t.mock.method(Page, "findOneAndUpdate", async () => null);
  t.mock.method(Page, "exists", async () => ({ _id: "page" }));
  await assert.rejects(reanalyzePage("book", 4), (error) => error.status === 409 && /already queued or being analyzed/.test(error.message));
});

test("resume preserves running claims and only retries failed pages", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let updateFilter;
  const book = { _id: "book", status: "queued" };
  t.mock.method(Page, "updateMany", async (filter) => { updateFilter = filter; return { modifiedCount: 1 }; });
  t.mock.method(Page, "find", () => ({ lean: async () => [
    { pageNumber: 4, status: "processing", analysisRunId: "live-run", issues: [{ status: "accepted", severity: "minor" }] },
    { pageNumber: 5, status: "pending", issues: [] },
  ] }));
  t.mock.method(Book, "findById", async () => book);
  t.mock.method(Book, "findByIdAndUpdate", async (_id, update) => ({ ...book, status: Array.isArray(update) ? "processing" : "queued" }));
  const resumed = await resumeBook("book");
  assert.equal(updateFilter.status, "error");
  assert.equal(resumed.status, "processing");
});

test("forced recovery cannot revoke pages covered by a live worker lease", async (t) => {
  t.mock.method(QueueLock, "exists", async () => ({ _id: "lease" }));
  const update = t.mock.method(Page, "updateMany", async () => { throw new Error("must not revoke a live claim"); });
  assert.equal(await recoverStalePages({ allProcessing: true }), 0);
  assert.equal(update.mock.callCount(), 0);
});

test("ordinary recovery uses processing heartbeat rather than unchanged finding timestamps", async (t) => {
  let recoveryFilter;
  t.mock.method(Page, "updateMany", async (filter, update) => {
    recoveryFilter = filter;
    assert.equal(update.$unset.analysisRunId, 1);
    assert.equal(update.$unset.processingHeartbeatAt, 1);
    assert.equal(update.$unset.issues, undefined);
    return { modifiedCount: 0 };
  });
  assert.equal(await recoverStalePages(), 0);
  assert.equal(recoveryFilter.status, "processing");
  assert.equal(recoveryFilter.$or[0].processingHeartbeatAt.$lt instanceof Date, true);
  assert.deepEqual(recoveryFilter.$or[1].processingHeartbeatAt, { $exists: false });
});
