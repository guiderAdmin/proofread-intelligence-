import { NextResponse } from "next/server";

export function assertSameOrigin(request) {
  if (process.env.PROOFDESK_ALLOW_CROSS_ORIGIN === "true") return;
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (!origin || !host) return;
  if (new URL(origin).host !== host) throw new HttpError(403, "Cross-origin request rejected");
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function apiError(error, fallback = "Request failed") {
  const status = Number(error?.status || 500);
  if (status >= 500) console.error(fallback, error);
  return NextResponse.json(
    { error: status >= 500 ? fallback : error.message },
    { status }
  );
}
