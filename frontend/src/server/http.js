import { NextResponse } from "next/server";
import { HttpError } from "./validation.js";
export { HttpError, readJsonBody, validateBookId, validatePageNumber, validateCustomMarks } from "./validation.js";

export function assertSameOrigin(request) {
  if (process.env.PROOFDESK_ALLOW_CROSS_ORIGIN === "true") return;
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (!origin || !host) return;
  try {
    if (new URL(origin).host !== host) throw new HttpError(403, "Cross-origin request rejected");
  } catch {
    throw new HttpError(403, "Cross-origin request rejected");
  }
}

export function apiError(error, fallback = "Request failed") {
  const candidate = Number(error?.status);
  const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  if (status >= 500) console.error(fallback, error);
  return NextResponse.json(
    { error: status >= 500 ? fallback : error.message },
    { status }
  );
}
