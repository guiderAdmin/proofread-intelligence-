import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import Book from "@/server/models/Book.js";
import Page from "@/server/models/Page.js";
import { connectDb } from "@/server/db.js";
import { assertSameOrigin, apiError, HttpError } from "@/server/http.js";
import { removeBookFiles, serializeBook, serializePage, tick } from "@/server/services/queue.js";
import { deleteAgentSession } from "../../../../../feature/agentic-bot/server/knowledge.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validateId(id: string) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid proofread id");
}

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    validateId(params.id);
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
    validateId(params.id);
    await connectDb();
    const book = await Book.findById(params.id);
    if (!book) throw new HttpError(404, "Proofread not found");
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
    validateId(params.id);
    await connectDb();
    const book = await Book.findById(params.id);
    if (!book) throw new HttpError(404, "Proofread not found");
    
    const body = await request.json();
    if (body.customMarks !== undefined) {
      book.customMarks = body.customMarks;
      book.markModified('customMarks');
      await book.save();
    }
    
    return NextResponse.json({ success: true, customMarks: book.customMarks });
  } catch (error) {
    return apiError(error, "Unable to update this proofread");
  }
}
