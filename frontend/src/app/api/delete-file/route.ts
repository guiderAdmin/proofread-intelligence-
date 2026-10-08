import { NextResponse } from "next/server";
import { assertSameOrigin, apiError, readJsonBody } from "@/server/http.js";
import { deleteUploadObject, validateUploadKey, validatePdfParts } from "@/server/storage.js";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { filename, objectKey, totalParts } = await readJsonBody(request);
    const key = validateUploadKey(objectKey || filename || "");
    await deleteUploadObject(key, validatePdfParts(totalParts ?? 1));
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error, "Unable to remove the temporary upload");
  }
}
