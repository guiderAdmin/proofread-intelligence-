import { NextResponse } from "next/server";
import Page from "@/server/models/Page.js";
import { connectDb } from "@/server/db.js";
import { apiError, HttpError, validateBookId, validatePageNumber } from "@/server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { id: string; pageNumber: string } }) {
  try {
    validateBookId(params.id);
    const pageNumber = validatePageNumber(params.pageNumber);
    await connectDb();
    const page: any = await Page.findOne({ bookId: params.id, pageNumber }).lean();
    if (!page?.imagePath) throw new HttpError(404, "Page image is not ready");

    // Cloudinary URL (Vercel-deployed) — redirect directly
    if (page.imagePath.startsWith("http")) {
      return NextResponse.redirect(page.imagePath, { status: 302 });
    }

    // Local filesystem fallback (local dev with persistent storage)
    const { existsSync, createReadStream } = await import("fs");
    const { Readable } = await import("stream");
    if (!existsSync(page.imagePath)) throw new HttpError(404, "Page image is not ready");
    const body = Readable.toWeb(createReadStream(page.imagePath)) as ReadableStream;
    return new Response(body, {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" },
    });
  } catch (error) {
    return apiError(error, "Unable to read page image");
  }
}
