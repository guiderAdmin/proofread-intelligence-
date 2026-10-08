import { NextRequest, NextResponse } from "next/server";
import { connectDb } from "@/server/db.js";
import ChapterContext from "../../../../../../feature/chapter-proofreader/server/ChapterContext.js";
import { tick } from "@/server/services/queue.js";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: { id: string } }) {
  try {
    await connectDb();
    const { id } = await context.params;
    const chapters = await ChapterContext.find({ bookId: id }).sort({ startPage: 1 }).lean();
    return NextResponse.json({ chapters });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
export async function POST(request: NextRequest, context: { params: { id: string } }) {
  try {
    await connectDb();
    const { id } = await context.params;
    
    // We import Book here to avoid circular dependencies if any
    const Book = (await import("@/server/models/Book.js")).default;
    
    const book = await Book.findById(id);
    if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });
    
    book.chapterAnalysis = book.chapterAnalysis || {};
    book.chapterAnalysis.contextApproved = true;
    book.status = "queued"; // Resume queue
    
    // Tell mongoose mixed type changed
    book.markModified("chapterAnalysis");
    await book.save();
    
    if (!process.env.VERCEL) setTimeout(() => tick(), 0); // Wake up the background processing loop
    
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
