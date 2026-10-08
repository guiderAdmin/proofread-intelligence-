import type { ProofreaderIssue } from "../types/proofreader";

function identity(issue: ProofreaderIssue) {
  const page = issue.page ?? issue.pageIndex;
  return issue.backendUid
    ? `${page}:${issue.backendUid}`
    : `${page}:${issue.id}:${issue.originalText}:${issue.suggestedText}`;
}

/** A late geometry result must never restore stale findings or review decisions. */
export function applyIssueGeometry(current: ProofreaderIssue[], located: ProofreaderIssue[]) {
  const byIdentity = new Map(located.map((issue) => [identity(issue), issue]));
  return current.map((issue) => {
    const match = byIdentity.get(identity(issue));
    return match ? { ...issue, bbox: match.bbox, bboxSource: match.bboxSource } : issue;
  });
}

/** Preserve numeric UI IDs when polling adds findings before existing ones. */
export function stabilizeIssueIds(incoming: ProofreaderIssue[], current: ProofreaderIssue[]) {
  const ids = new Map(current.filter((issue) => issue.backendUid).map((issue) => [identity(issue), issue.id]));
  let nextId = Math.max(0, ...current.map((issue) => issue.id)) + 1;
  return incoming.map((issue) => ({ ...issue, id: ids.get(identity(issue)) ?? nextId++ }));
}

/** Ignore review flags in a GET snapshot that predates a local decision. */
export function mergeIssueReviews(
  incoming: ProofreaderIssue[], current: ProofreaderIssue[],
  pending: Map<string, "open" | "accepted" | "dismissed">,
  staleReviewSnapshot = false,
) {
  const previous = new Map(current.map((issue) => [identity(issue), issue]));
  return stabilizeIssueIds(incoming, current).map((issue) => {
    const status = issue.backendUid && pending.get(issue.backendUid);
    if (status) return { ...issue, resolved: status === "accepted", ignored: status === "dismissed" };
    const prior = previous.get(identity(issue));
    return staleReviewSnapshot && prior ? { ...issue, resolved: prior.resolved, ignored: prior.ignored } : issue;
  });
}

/** Serialize snapshots so an older, slower request cannot overwrite a newer one. */
export function createSerialWriter<T>(write: (value: T) => Promise<void>) {
  let tail = Promise.resolve();
  return (value: T) => {
    const request = tail.then(() => write(value));
    tail = request.catch(() => {});
    return request;
  };
}
