"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary: a render exception in any stage shows a recovery
 * screen instead of a blank/crashed page. Saved proofreads live on the server,
 * so "Try again" re-mounts the app and restores the session.
 */
export default function Error({
  error,
  reset,
}: {
  error: globalThis.Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app error boundary]", error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-bold text-slate-900">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-500">
          The screen hit an unexpected error. Your proofreads are saved — reload to continue where you left off.
        </p>
        <div className="mt-5 flex justify-center gap-3">
          <button
            onClick={() => reset()}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
