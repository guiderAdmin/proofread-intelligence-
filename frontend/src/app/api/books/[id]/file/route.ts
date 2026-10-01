import { NextResponse } from "next/server";
import Book from "@/server/models/Book.js";
import { connectDb } from "@/server/db.js";
import { apiError, HttpError } from "@/server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    await connectDb();
    const book: any = await Book.findById(params.id).lean();
    if (!book) throw new HttpError(404, "Proofread not found");

    // Cloudinary-stored PDF (Vercel deployment)
    if (book.cloudinaryPdfKey) {
      const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
      if (!cloudName) throw new HttpError(500, "Cloudinary not configured");
      
      // If it's a single file, it's just part0 essentially, or we use the base key
      // We'll stitch it dynamically on the fly and stream it to the browser to avoid CORS issues with 302 redirects
      let currentPart = 0;
      const totalParts = book.pdfParts && book.pdfParts > 0 ? book.pdfParts : 1;
      const objectKey = book.cloudinaryPdfKey;

      const stream = new ReadableStream({
        async pull(controller) {
          if (currentPart >= totalParts) {
            controller.close();
            return;
          }
          let partKey = objectKey;
          if (book.pdfParts && book.pdfParts > 1) {
            partKey = `${objectKey}.part${currentPart}`;
          }
          const downloadKey = partKey.toLowerCase().endsWith(".pdf") ? partKey : `${partKey}.pdf`;
          const url = `https://res.cloudinary.com/${cloudName}/raw/upload/${downloadKey}`;

          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) {
            controller.error(new Error(`Failed to fetch PDF part ${currentPart}: ${res.statusText}`));
            return;
          }

          if (res.body) {
            const reader = res.body.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
            } finally {
              reader.releaseLock();
            }
          }
          currentPart++;
        }
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${String(book.originalName || "document.pdf").replace(/["\r\n]/g, "_")}"`,
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
        "Content-Disposition": `inline; filename="${String(book.originalName || "document.pdf").replace(/["\\r\\n]/g, "_")}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return apiError(error, "Unable to read PDF");
  }
}
