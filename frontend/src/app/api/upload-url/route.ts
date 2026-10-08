import { randomUUID, createHash } from "crypto";
import { NextResponse } from "next/server";
import { assertSameOrigin, apiError, HttpError, readJsonBody } from "@/server/http.js";
import { safePdfName, MAX_PDF_BYTES, MAX_PDF_PARTS } from "@/server/storage.js";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { filename, contentType, fileSize, partIndex, baseId } = await readJsonBody(request);
    if (typeof filename !== "string" || !filename.toLowerCase().endsWith(".pdf")) {
      throw new HttpError(400, "A PDF filename is required");
    }
    if (contentType && contentType !== "application/pdf") {
      throw new HttpError(400, "Only PDF uploads are allowed");
    }
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
      throw new HttpError(400, "A positive PDF upload size is required");
    }
    if (fileSize > MAX_PDF_BYTES) {
      throw new HttpError(413, "PDF exceeds the 250 MB limit");
    }
    if (baseId !== undefined && (typeof baseId !== "string" || !/^[A-Za-z\d_-]{1,80}$/.test(baseId))) {
      throw new HttpError(400, "Invalid upload identity");
    }
    if (partIndex !== undefined && (!Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= MAX_PDF_PARTS)) {
      throw new HttpError(400, "Invalid upload part index");
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      throw new HttpError(500, "Cloudinary upload storage is not configured");
    }

    const uuid = baseId || randomUUID();
    let publicId = `proofreader_assets/pdf_${uuid}_${safePdfName(filename).replace(/\.pdf$/i, '')}`;
    if (partIndex !== undefined) {
      publicId += `.part${partIndex}`;
    }
    const timestamp = Math.round(new Date().getTime() / 1000);
    
    // Cloudinary expects parameters to be sorted alphabetically when signing
    const paramsToSign = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
    const signature = createHash("sha256").update(paramsToSign).digest("hex");

    return NextResponse.json({ 
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`,
      signature, 
      timestamp,
      apiKey,
      publicId,
      objectKey: publicId // Cloudinary public_id (no extension for raw resources)
    });
  } catch (error) {
    return apiError(error, "Unable to prepare the PDF upload");
  }
}
