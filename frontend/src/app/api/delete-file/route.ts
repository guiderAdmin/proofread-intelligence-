import { NextResponse } from "next/server";
import { assertSameOrigin, apiError, HttpError } from "@/server/http.js";
import { deleteUploadObject } from "@/server/storage.js";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { filename, objectKey } = await request.json();
    const key = String(objectKey || filename || "");
    if (!key.startsWith("proofreader_assets/")) throw new HttpError(400, "Invalid temporary upload key");
    await deleteUploadObject(key);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error, "Unable to remove the temporary upload");
  }
}
