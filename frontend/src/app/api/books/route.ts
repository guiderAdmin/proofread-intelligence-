import { NextResponse } from "next/server";
import Book from "@/server/models/Book.js";
import { connectDb } from "@/server/db.js";
import { apiError } from "@/server/http.js";
import { serializeBook } from "@/server/services/queue.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await connectDb();
    const books = await Book.find().sort({ createdAt: -1 }).limit(100).lean();
    return NextResponse.json(books.map((book: any) => serializeBook(book)));
  } catch (error) {
    return apiError(error, "Unable to load proofreads");
  }
}
