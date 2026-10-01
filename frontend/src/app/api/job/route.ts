import { NextRequest, NextResponse } from "next/server";
import Book from "@/server/models/Book.js";
import Page from "@/server/models/Page.js";
import { connectDb } from "@/server/db.js";
import { apiError, HttpError } from "@/server/http.js";
import { serializeBook, serializePage, tick } from "@/server/services/queue.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new HttpError(400, "Missing job id");
    await connectDb();
    const book = await Book.findById(id);
    if (!book) throw new HttpError(404, "Job not found");
    const pages = await Page.find({ bookId: book._id }).sort({ pageNumber: 1 }).lean();
    if (["queued", "processing"].includes(book.status)) setTimeout(() => tick(), 0);
    return NextResponse.json({ book: serializeBook(book), pages: pages.map((page: any) => serializePage(page)) });
  } catch (error) {
    return apiError(error, "Unable to load job status");
  }
}
