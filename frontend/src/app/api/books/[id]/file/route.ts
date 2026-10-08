import { NextResponse } from "next/server";
import Book from "@/server/models/Book.js";
import { connectDb } from "@/server/db.js";
import { apiError, HttpError, validateBookId } from "@/server/http.js";
import { pdfContentDisposition } from "@/server/validation.js";
import { MAX_PDF_BYTES, pdfObjectUrl, validatePdfParts } from "@/server/storage.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    validateBookId(params.id);
    await connectDb();
    const book: any = await Book.findById(params.id).lean();
    if (!book) throw new HttpError(404, "Proofread not found");

    const { existsSync, createReadStream } = await import("fs");
    if (!book?.filePath || !existsSync(book.filePath)) throw new HttpError(404, "PDF file is unavailable");
    
    const stream = createReadStream(book.filePath);
    const body = new ReadableStream({
      start(controller) {
        stream.on("data", (chunk: any) => controller.enqueue(new Uint8Array(chunk)));
        stream.on("end", () => controller.close());
        stream.on("error", (error) => controller.error(error));
      },
      cancel() {
        stream.destroy();
      },
    });
    
    return new Response(body, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": pdfContentDisposition(book.originalName),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("PDF File Route Error:", error);
    return apiError(error, "Unable to read PDF");
  }
}
