import { NextRequest, NextResponse } from "next/server";
import { connectDb } from "@/server/db.js";
import { runWorkerSlice } from "@/server/services/queue.js";
import { apiError, assertSameOrigin, HttpError, readJsonBody, validateBookId } from "@/server/http.js";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
export async function POST(request:NextRequest) {
  try {
    assertSameOrigin(request);
    if(!request.headers.get("origin"))throw new HttpError(403,"Worker requests require a same-origin browser.");
    const body=await readJsonBody(request);validateBookId(body.bookId);
    await connectDb();
    return NextResponse.json(await runWorkerSlice({bookId:body.bookId}));
  }catch(error){return apiError(error,"The worker could not complete this request. Saved findings remain available.");}
}
// No scheduler entry point. Vercel work is explicitly driven by the browser.
export async function GET() {
  return NextResponse.json({error:"Use the application to process pages."},{status:405,headers:{Allow:"POST"}});
}
