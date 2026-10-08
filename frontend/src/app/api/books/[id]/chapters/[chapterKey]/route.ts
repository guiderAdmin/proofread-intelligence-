import { NextRequest, NextResponse } from "next/server";
import { connectDb } from "@/server/db.js";
import ChapterContext from "../../../../../../../feature/chapter-proofreader/server/ChapterContext.js";

export const runtime = "nodejs";

export async function PUT(request: NextRequest, context: { params: { id: string, chapterKey: string } }) {
  try {
    await connectDb();
    const { id, chapterKey } = await context.params;
    const body = await request.json();

    if (typeof body.customContextOverride !== "string") {
      return NextResponse.json({ error: "Missing customContextOverride" }, { status: 400 });
    }

    const updated = await ChapterContext.findOneAndUpdate(
      { bookId: id, chapterKey },
      { $set: { customContextOverride: body.customContextOverride } },
      { new: true }
    );

    if (!updated) {
      return NextResponse.json({ error: "Chapter not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, chapter: updated });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
