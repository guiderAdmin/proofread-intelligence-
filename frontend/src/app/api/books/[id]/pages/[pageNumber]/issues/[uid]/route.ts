import { NextRequest, NextResponse } from "next/server";
import Page from "@/server/models/Page.js";
import { connectDb } from "@/server/db.js";
import { assertSameOrigin, apiError, HttpError, readJsonBody, validateBookId, validatePageNumber } from "@/server/http.js";
import { refreshBookStats, serializePage } from "@/server/services/queue.js";

export const runtime = "nodejs";
const VALID_STATUSES = new Set(["open", "accepted", "dismissed", "fixed"]);

export async function PATCH(request: NextRequest, { params }: { params: { id: string; pageNumber: string; uid: string } }) {
  try {
    assertSameOrigin(request);
    validateBookId(params.id);
    const pageNumber = validatePageNumber(params.pageNumber);
    const body = await readJsonBody(request);
    if (!VALID_STATUSES.has(body.status)) throw new HttpError(400, "Invalid issue status");
    await connectDb();
    // Update just this decision. Saving a previously loaded issues array can
    // overwrite another review decision or findings from a completed analysis.
    const page = await Page.findOneAndUpdate(
      { bookId: params.id, pageNumber, "issues.uid": params.uid },
      { $set: { "issues.$.status": body.status }, $inc: { issueRevision: 1 } },
      { new: true, runValidators: true }
    );
    if (!page) throw new HttpError(404, "Page or issue not found");
    await refreshBookStats(page.bookId);
    return NextResponse.json({ page: serializePage(page) });
  } catch (error) {
    return apiError(error, "Unable to save issue status");
  }
}
