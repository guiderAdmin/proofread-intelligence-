import { NextRequest, NextResponse } from "next/server";
import Page from "@/server/models/Page.js";
import { connectDb } from "@/server/db.js";
import { assertSameOrigin, apiError, HttpError } from "@/server/http.js";
import { refreshBookStats, serializePage } from "@/server/services/queue.js";

export const runtime = "nodejs";
const VALID_STATUSES = new Set(["open", "accepted", "dismissed", "fixed"]);

export async function PATCH(request: NextRequest, { params }: { params: { id: string; pageNumber: string; uid: string } }) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    if (!VALID_STATUSES.has(body.status)) throw new HttpError(400, "Invalid issue status");
    await connectDb();
    const page = await Page.findOne({ bookId: params.id, pageNumber: Number(params.pageNumber) });
    if (!page) throw new HttpError(404, "Page not found");
    const issue = page.issues.find((item: any) => item.uid === params.uid);
    if (!issue) throw new HttpError(404, "Issue not found");
    issue.status = body.status;
    page.markModified("issues");
    await page.save();
    await refreshBookStats(page.bookId);
    return NextResponse.json({ page: serializePage(page) });
  } catch (error) {
    return apiError(error, "Unable to save issue status");
  }
}
