import { NextResponse } from "next/server";
import { connectDb } from "@/server/db.js";
import { assertSameOrigin, apiError, HttpError, validateBookId } from "@/server/http.js";
import { pauseBook, serializeBook } from "@/server/services/queue.js";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    assertSameOrigin(request);
    validateBookId(params.id);
    await connectDb();
    const book = await pauseBook(params.id);
    if (!book) throw new HttpError(404, "Proofread not found");
    return NextResponse.json({ book: serializeBook(book) });
  } catch (error) {
    return apiError(error, "Unable to pause analysis");
  }
}
