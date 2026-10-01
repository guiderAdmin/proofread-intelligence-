import { NextRequest, NextResponse } from "next/server";
import Book from "@/server/models/Book.js";
import Page from "@/server/models/Page.js";
import { connectDb } from "@/server/db.js";
import { apiError, HttpError } from "@/server/http.js";
import { serializeBook } from "@/server/services/queue.js";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    await connectDb();
    const book = await Book.findById(params.id);
    if (!book) throw new HttpError(404, "Proofread not found");
    const pages = await Page.find({ bookId: book._id }).sort({ pageNumber: 1 }).lean();
    const query = new URL(request.url).searchParams;
    const status = query.get("status") || "accepted";
    const rows = pages.flatMap((page: any) =>
      (page.issues || [])
        .filter((issue: any) => status === "all" || issue.status === status)
        .map((issue: any) => ({
          page: page.pageNumber,
          type: issue.type,
          severity: issue.severity,
          quote: issue.quote,
          suggestion: issue.suggestion,
          explanation: issue.explanation,
          confidence: issue.confidence,
          status: issue.status,
        }))
    );

    if (query.get("format") === "json") {
      return NextResponse.json({ book: serializeBook(book), issues: rows });
    }
    const header = ["Page", "Type", "Severity", "Found", "Suggestion", "Why", "Confidence", "Status"];
    const csv = [header, ...rows.map((row: any) => Object.values(row))]
      .map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const filename = String(book.title || "proof").replace(/[^a-z0-9_-]+/gi, "-");
    return new Response(`\uFEFF${csv}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}-issues.csv"`,
      },
    });
  } catch (error) {
    return apiError(error, "Unable to export issues");
  }
}
