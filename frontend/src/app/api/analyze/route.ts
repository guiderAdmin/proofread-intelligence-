import { NextRequest, NextResponse } from "next/server";
import Book from "@/server/models/Book.js";
import { connectDb } from "@/server/db.js";
import { assertSameOrigin, apiError, HttpError } from "@/server/http.js";
import { tempPdfPath, deleteUploadObject, downloadPdfObject } from "@/server/storage.js";
import { getPageCount } from "@/server/services/pdf.js";
import { enqueueBook, removeBookFiles, serializeBook } from "@/server/services/queue.js";
import { DEFAULT_MODEL, hasAnyKey, resolveModel } from "@/server/services/gemini.js";
import { compileProjectInstructions } from "../../../../feature/agentic-bot/server/instructions.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LANGUAGES = new Set(["auto", "english", "hindi", "mixed"]);
const BOOK_TYPES = new Set(["textbook", "workbook", "story", "general"]);

export async function POST(request: NextRequest) {
  let book: any = null;
  let objectKey = "";
  try {
    assertSameOrigin(request);
    await connectDb();
    if (!hasAnyKey()) throw new HttpError(503, "Configure GEMINI_API_KEY before starting an analysis");

    const body = await request.json();
    objectKey = String(body.pdfFilename || body.objectKey || "");
    if (!objectKey) throw new HttpError(400, "Uploaded PDF key is required");

    const originalName = String(body.originalName || objectKey.split("/").pop() || "document.pdf");
    const languageInput = String(body.language || "auto").toLowerCase();
    const bookTypeInput = String(body.bookType || "textbook").toLowerCase();
    const totalParts = Number(body.totalParts || 1);

    const instructionBrief = compileProjectInstructions(body.proofreadingInstructions);
    book = await Book.create({
      title: String(body.title || originalName.replace(/\.pdf$/i, "")).trim().slice(0, 180),
      originalName: originalName.slice(0, 220),
      classLevel: String(body.classLevel || "").trim().slice(0, 80),
      subject: String(body.subject || "").trim().slice(0, 100),
      filePath: "pending",
      cloudinaryPdfKey: objectKey, // saved now so page workers can re-download
      pdfParts: totalParts,
      language: LANGUAGES.has(languageInput) ? languageInput : "auto",
      bookType: BOOK_TYPES.has(bookTypeInput) ? bookTypeInput : "textbook",
      model: resolveModel(body.model || process.env.GEMINI_MODEL || DEFAULT_MODEL),
      thinkingLevel: String(body.thinkingLevel || process.env.GEMINI_THINKING_LEVEL || "low"),
      proofreadingInstructions: instructionBrief.text,
      status: "queued",
    });

    // Download to /tmp — writable on both Vercel and persistent servers
    const destination = tempPdfPath(book._id);
    await downloadPdfObject(objectKey, totalParts, destination);
    book.filePath = destination;
    book.pageCount = await getPageCount(destination);
    if (!book.pageCount) throw new HttpError(400, "The PDF contains no readable pages");
    await book.save();
    await enqueueBook(book);
    // NOTE: We deliberately do NOT delete from Cloudinary here.
    // The PDF must remain available so page-processing workers can re-download
    // it on each serverless invocation. It will be deleted when the book is removed.
    return NextResponse.json({ jobId: String(book._id), book: serializeBook(book) }, { status: 201 });
  } catch (error: any) {
    if (book?._id) {
      await removeBookFiles(book._id).catch(() => {});
      await Book.deleteOne({ _id: book._id }).catch(() => {});
    }
    if (objectKey) await deleteUploadObject(objectKey).catch(() => {});
    return apiError(error, "Unable to start PDF analysis");
  }
}
