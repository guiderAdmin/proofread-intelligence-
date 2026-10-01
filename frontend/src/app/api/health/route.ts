import { NextResponse } from "next/server";
import { connectDb, mongoReady } from "@/server/db.js";
import { apiError } from "@/server/http.js";
import { currentProvider, hasAnyKey, resolveModel } from "@/server/services/gemini.js";
import { getQueueState, recoverStalePages } from "@/server/services/queue.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await connectDb();
    await recoverStalePages();
    return NextResponse.json({
      ok: true,
      mongo: mongoReady(),
      ready: mongoReady() && hasAnyKey(),
      provider: currentProvider(),
      model: resolveModel(),
      queue: getQueueState(),
    });
  } catch (error) {
    return apiError(error, "ProofDesk backend is not ready");
  }
}
