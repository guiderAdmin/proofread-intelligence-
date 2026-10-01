import { NextRequest, NextResponse } from "next/server";

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function middleware(request: NextRequest) {
  const expectedUser = process.env.PROOFDESK_BASIC_USER;
  const expectedPassword = process.env.PROOFDESK_BASIC_PASSWORD;
  if (!expectedUser || !expectedPassword) return NextResponse.next();

  const authorization = request.headers.get("authorization") || "";
  if (authorization.startsWith("Basic ")) {
    try {
      const decoded = atob(authorization.slice(6));
      const separator = decoded.indexOf(":");
      const user = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);
      if (separator > 0 && safeEqual(user, expectedUser) && safeEqual(password, expectedPassword)) {
        return NextResponse.next();
      }
    } catch {
      // Fall through to a generic challenge without exposing which value failed.
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="ProofDesk", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
