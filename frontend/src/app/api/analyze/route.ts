import { NextRequest, NextResponse } from "next/server";
import Book from "@/server/models/Book.js";
import Page from "@/server/models/Page.js";
import { connectDb } from "@/server/db.js";
import { assertSameOrigin, apiError, HttpError, readJsonBody } from "@/server/http.js";
import { tempPdfPath, deleteUploadObject, downloadPdfObject, validateUploadKey, validatePdfParts } from "@/server/storage.js";
import { getPageCount } from "@/server/services/pdf.js";
import { enqueueBook, removeBookFiles, serializeBook } from "@/server/services/queue.js";
import { DEFAULT_MODEL, hasAnyKey, resolveModel } from "@/server/services/gemini.js";
import { compileProjectInstructions } from "../../../../feature/agentic-bot/server/instructions.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LANGUAGES = new Set(["auto", "english", "hindi", "mixed"]);
const BOOK_TYPES = new Set(["textbook", "workbook", "story", "general"]);

export async function POST(request: NextRequest) {
  let book: any = null;
  let objectKey = "";
  let totalParts = 1;
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    objectKey = validateUploadKey(body.pdfFilename || body.objectKey || "");
    totalParts = validatePdfParts(body.totalParts ?? 1);
    await connectDb();
    if (!hasAnyKey()) throw new HttpError(503, "Configure GEMINI_API_KEY before starting an analysis");

    const originalName = String(body.originalName || objectKey.split("/").pop() || "document.pdf");
    const languageInput = String(body.language || "auto").toLowerCase();
    const bookTypeInput = String(body.bookType || "textbook").toLowerCase();

    const instructionBrief = compileProjectInstructions(body.proofreadingInstructions);
    book = await Book.create({
      title: (String(body.title || originalName.replace(/\.pdf$/i, "")).trim() || "Untitled proofread").slice(0, 180),
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
      // insertMany can fail after inserting only some Page jobs. Remove those
      // jobs as well as the Book so they cannot be claimed as orphan work.
      await Book.updateOne({ _id: book._id }, { $set: { status: "paused" } }).catch(() => {});
      await Page.deleteMany({ bookId: book._id }).catch(() => {});
      await removeBookFiles(book._id).catch(() => {});
      await Book.deleteOne({ _id: book._id }).catch(() => {});
    } else if (objectKey) {
      await deleteUploadObject(objectKey, totalParts).catch(() => {});
    }
    return apiError(error, "Unable to start PDF analysis");
  }
}
