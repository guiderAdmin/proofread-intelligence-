import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { storageRoot } from "@/server/storage.js";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id || id.includes("..")) return new NextResponse("Not found", { status: 404 });
    const targetPath = path.join(storageRoot(), id);
    const buffer = await fs.readFile(targetPath);
    return new NextResponse(buffer, {
      headers: { "Content-Type": "image/jpeg" },
    });
  } catch (error) {
    return new NextResponse("Not found", { status: 404 });
  }
}
