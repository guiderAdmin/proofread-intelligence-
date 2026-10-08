import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { storageRoot } from "@/server/storage.js";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File;
    const publicId = formData.get("public_id") as string;

    if (!file || !publicId) {
      return NextResponse.json({ error: "Missing file or public_id" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    
    const storageDir = storageRoot();
    await fs.mkdir(storageDir, { recursive: true });
    
    const targetPath = path.join(storageDir, publicId);
    
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    
    await fs.writeFile(targetPath, buffer);

    return NextResponse.json({ success: true, url: `/local-storage/${publicId}` });
  } catch (error: any) {
    console.error("Local upload error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
