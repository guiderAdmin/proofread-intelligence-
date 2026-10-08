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

    // Cloudinary-stored PDF (Vercel deployment)
    if (book.cloudinaryPdfKey) {
      // Read one chunk per pull so the browser's backpressure bounds memory.
      // The old pull enqueued an entire multipart file even after cancellation.
      let currentPart = 0;
      let totalBytes = 0;
      const totalParts = validatePdfParts(book.pdfParts ?? 1);
      const objectKey = book.cloudinaryPdfKey;
      const abort = new AbortController();
      const stop = () => abort.abort();
      _request.signal.addEventListener("abort", stop, { once: true });
      if (_request.signal.aborted) stop();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const cleanUp = () => {
        if (timeout) clearTimeout(timeout);
        _request.signal.removeEventListener("abort", stop);
      };
      const fetchPart = async (part: number) => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => abort.abort(), 60_000);
        const response = await fetch(pdfObjectUrl(objectKey, part, totalParts), { cache: "no-store", signal: abort.signal });
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => {});
          throw new HttpError(502, `Unable to retrieve PDF part ${part + 1}`);
        }
        return response.body.getReader();
      };
      // Check the first part before committing HTTP 200, so a missing original
      // produces an actionable API error instead of a broken PDF response.
      let reader: ReadableStreamDefaultReader<Uint8Array>;
      try {
        reader = await fetchPart(0);
      } catch (error) {
        cleanUp();
        throw error;
      }

      const stream = new ReadableStream({
        async pull(controller) {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (!done) {
                totalBytes += value.byteLength;
                if (totalBytes > MAX_PDF_BYTES) throw new HttpError(413, "PDF exceeds the 250 MB limit");
                controller.enqueue(value);
                return;
              }
              reader.releaseLock();
              currentPart += 1;
              if (currentPart >= totalParts) {
                cleanUp();
                controller.close();
                return;
              }
              reader = await fetchPart(currentPart);
            }
          } catch (error) {
            cleanUp();
            abort.abort();
            await reader.cancel().catch(() => {});
            controller.error(error);
          }
        },
        async cancel() {
          cleanUp();
          abort.abort();
          await reader.cancel().catch(() => {});
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": pdfContentDisposition(book.originalName),
          "Cache-Control": "private, no-store",
        },
      });
    }

    // Local filesystem fallback (local dev or persistent server without Cloudinary key)
    const { existsSync, createReadStream } = await import("fs");
    const { Readable } = await import("stream");
    if (!book?.filePath || !existsSync(book.filePath)) throw new HttpError(404, "PDF file is unavailable");
    const body = Readable.toWeb(createReadStream(book.filePath)) as ReadableStream;
    return new Response(body, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": pdfContentDisposition(book.originalName),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return apiError(error, "Unable to read PDF");
  }
}
