import { NextRequest, NextResponse } from "next/server";
import Book from "@/server/models/Book.js";
import Page from "@/server/models/Page.js";
import { connectDb } from "@/server/db.js";
import { assertSameOrigin, apiError, HttpError, readJsonBody, validateBookId, validateCustomMarks } from "@/server/http.js";
import { removeBookFiles, serializeBook, serializePage, tick } from "@/server/services/queue.js";
import { deleteAgentSession } from "../../../../../feature/agentic-bot/server/knowledge.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    validateBookId(params.id);
    await connectDb();
    const book = await Book.findById(params.id);
    if (!book) throw new HttpError(404, "Proofread not found");
    const pages = await Page.find({ bookId: book._id }).sort({ pageNumber: 1 }).lean();
    if (["queued", "processing"].includes(book.status)) setTimeout(() => tick(), 0);
    return NextResponse.json({ book: serializeBook(book), pages: pages.map((page: any) => serializePage(page)) });
  } catch (error) {
    return apiError(error, "Unable to load this proofread");
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    assertSameOrigin(request);
    validateBookId(params.id);
    await connectDb();
    const book = await Book.findById(params.id);
    if (!book) throw new HttpError(404, "Proofread not found");
    // Stop new page claims before deleting durable jobs and remote assets.
    await Book.updateOne({ _id: book._id }, { $set: { status: "paused" } });
    await Page.deleteMany({ bookId: book._id });
    await deleteAgentSession(book._id);
    await removeBookFiles(book._id);
    await book.deleteOne();
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error, "Unable to delete this proofread");
  }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    assertSameOrigin(request);
    validateBookId(params.id);
    await connectDb();
    const book = await Book.findById(params.id);
    if (!book) throw new HttpError(404, "Proofread not found");
    
    const body = await readJsonBody(request);
    if (body.customMarks !== undefined) {
      const customMarks = validateCustomMarks(body.customMarks, book.pageCount);
      const updated = await Book.findByIdAndUpdate(params.id, { $set: { customMarks } }, { new: true });
      if (!updated) throw new HttpError(404, "Proofread not found");
      return NextResponse.json({ success: true, customMarks: updated.customMarks });
    }
    
    return NextResponse.json({ success: true, customMarks: book.customMarks });
  } catch (error) {
    return apiError(error, "Unable to update this proofread");
  }
}
