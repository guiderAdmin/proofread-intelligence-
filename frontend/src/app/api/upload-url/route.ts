import { randomUUID, createHash } from "crypto";
import { NextResponse } from "next/server";
import { assertSameOrigin, apiError, HttpError } from "@/server/http.js";
import { safePdfName } from "@/server/storage.js";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { filename, contentType, fileSize, partIndex, baseId } = await request.json();
    if (!filename || !String(filename).toLowerCase().endsWith(".pdf")) {
      throw new HttpError(400, "A PDF filename is required");
    }
    if (contentType && contentType !== "application/pdf") {
      throw new HttpError(400, "Only PDF uploads are allowed");
    }
    if (Number(fileSize || 0) > 500 * 1024 * 1024) {
      throw new HttpError(413, "PDF exceeds the 500 MB limit");
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
