// The previous Express application pushed in-memory SSE messages. The Next.js
// application reads durable MongoDB state instead, so queue notifications are
// intentionally advisory. Keeping this function preserves the queue boundary
// without making correctness depend on a single process staying alive.
export function emit() {}
