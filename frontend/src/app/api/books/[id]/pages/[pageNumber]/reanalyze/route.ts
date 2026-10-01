import { NextResponse } from "next/server";
import { connectDb } from "@/server/db.js";
import { assertSameOrigin, apiError, HttpError } from "@/server/http.js";
import { reanalyzePage, serializePage } from "@/server/services/queue.js";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: { id: string; pageNumber: string } }) {
  try {
    assertSameOrigin(request);
    const pageNumber = Number(params.pageNumber);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new HttpError(400, "Invalid page number");
    await connectDb();
    const page = await reanalyzePage(params.id, pageNumber);
    return NextResponse.json({ page: serializePage(page) });
  } catch (error) {
    return apiError(error, "Unable to reanalyze this page");
  }
}
