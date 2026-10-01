"use client";

import React from "react";
import { FileText, AlertCircle } from "lucide-react";
import { ProofreaderIssue } from "@/types/proofreader";
import dynamic from "next/dynamic";

// Load react-pdf components dynamically to prevent SSR errors in Next.js
const Document = dynamic(() => import("react-pdf").then((m) => m.Document), {
  ssr: false,
});
const Page = dynamic(() => import("react-pdf").then((m) => m.Page), {
  ssr: false,
});

// Lazy loader to prevent rendering 200+ canvases at once
function LazyPageWrapper({ children }: { children: React.ReactNode }) {
  const [isVisible, setIsVisible] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect(); // Once visible, keep it rendered
        }
      },
      { rootMargin: "400px" } // Load a bit ahead of scroll
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="w-full h-full flex items-center justify-center relative">
      {isVisible ? children : (
        <div className="w-full h-full bg-slate-50 flex items-center justify-center animate-pulse">
          <div className="text-[9px] font-bold text-slate-300">LOADING</div>
        </div>
      )}
    </div>
  );
}

interface PagesPreviewProps {
  totalPages: number;
  currentPage: number;
  setCurrentPage: (page: number) => void;
  issues: ProofreaderIssue[];
  stage: string;
  setStage: (stage: any) => void;
  selectedFile: any;
}

export function PagesPreview({
  totalPages,
  currentPage,
  setCurrentPage,
  issues,
  stage,
  setStage,
  selectedFile,
}: PagesPreviewProps) {
  const [fileUrl, setFileUrl] = React.useState<string | null>(null);
  const [detectedPages, setDetectedPages] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (typeof window !== "undefined") {
      import("react-pdf").then(({ pdfjs }) => {
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.js",
          import.meta.url,
        ).toString();
      });
    }
  }, []);

  React.useEffect(() => {
    if (selectedFile?.rawFile) {
      const url = URL.createObjectURL(selectedFile.rawFile);
      setFileUrl(url);
      setDetectedPages(null); // Reset when file changes
      return () => {
        URL.revokeObjectURL(url);
      };
    } else {
      setFileUrl(null);
      setDetectedPages(null);
    }
  }, [selectedFile]);

  const handleDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setDetectedPages(numPages);
  };

  if (!selectedFile) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-3">
        <div className="w-12 h-16 rounded-md border-2 border-dashed border-slate-200 flex items-center justify-center">
          <FileText className="h-6 w-6 text-slate-300" />
        </div>
        <div className="text-center">
          <p className="text-[11px] font-semibold text-slate-500 leading-relaxed">No active document</p>
          <p className="text-[10px] text-slate-400 mt-0.5">Upload a PDF to view pages.</p>
        </div>
      </div>
    );
  }

  // Dynamically resolve pageCount based on loaded PDF pages, DB totalPages, or default to 1 skeleton while loading
  const pageCount = detectedPages || totalPages || 1;

  const renderPageButtons = () => {
    return Array.from({ length: pageCount }, (_, i) => i + 1).map((pageNo) => {
      const isActivePage = currentPage === pageNo && stage === "review";
      const pageIssues = issues.filter((i) => (i.page ?? i.pageIndex) === pageNo && !i.resolved && !i.ignored);

      return (
        <button
          key={pageNo}
          onClick={() => {
            setCurrentPage(pageNo);
            setStage("review");
          }}
          className={`relative w-full flex flex-col items-center group transition-all duration-150 ${
            isActivePage ? "scale-[1.02]" : "hover:scale-[1.01]"
          }`}
        >
          {/* Page thumbnail — A4 aspect ratio (roughly 3:4) */}
          <div
            className={`w-full rounded-lg border-2 overflow-hidden bg-slate-50 transition-all duration-150 relative ${
              isActivePage
                ? "border-brand-500 shadow-md shadow-brand-500/20"
                : "border-slate-200 hover:border-slate-400 shadow-sm"
            } flex items-center justify-center`}
            style={{ aspectRatio: "3 / 4" }}
          >
            {fileUrl ? (
              <div className="w-full h-full flex items-center justify-center overflow-hidden bg-white pointer-events-none">
                <LazyPageWrapper>
                  <Page
                    pageNumber={pageNo}
                    width={180}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                    loading={
                      <div className="w-full h-full bg-white p-3 flex flex-col gap-1.5 animate-pulse">
                        <div className="h-2 rounded-full w-3/4 bg-slate-200" />
                        {Array.from({ length: 6 }).map((_, li) => (
                          <div
                            key={li}
                            className="h-1.5 rounded-full bg-slate-100"
                            style={{ width: `${60 + Math.sin(li * 1.7) * 30}%` }}
                          />
                        ))}
                      </div>
                    }
                  />
                </LazyPageWrapper>
              </div>
            ) : (
              /* Simulated page content lines fallback */
              <div className="w-full h-full bg-white p-3 flex flex-col gap-1.5">
                {/* Title line */}
                <div className={`h-2 rounded-full w-3/4 ${isActivePage ? "bg-brand-200" : "bg-slate-200"}`} />
                {/* Content lines */}
                {Array.from({ length: 8 }).map((_, li) => (
                  <div
                    key={li}
                    className={`h-1.5 rounded-full ${isActivePage ? "bg-brand-100" : "bg-slate-100"}`}
                    style={{ width: `${60 + Math.sin(li * 1.7) * 30}%` }}
                  />
                ))}
              </div>
            )}

            {/* Issue overlay badge */}
            {pageIssues.length > 0 && (
              <div className="absolute top-2 right-2 flex items-center gap-1 bg-red-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full shadow-sm z-30">
                <AlertCircle className="h-2.5 w-2.5" />
                {pageIssues.length}
              </div>
            )}
          </div>

          {/* Page label */}
          <span
            className={`mt-1.5 text-[10px] font-bold tracking-wide transition-colors ${
              isActivePage ? "text-brand-600" : "text-slate-400 group-hover:text-slate-600"
            }`}
          >
            Page {pageNo}
          </span>
        </button>
      );
    });
  };

  return (
    <div className="flex flex-col gap-3 pb-4">
      {fileUrl ? (
        <Document file={fileUrl} onLoadSuccess={handleDocumentLoadSuccess} loading={<div className="text-[10px] text-slate-400 text-center py-4">Loading Document...</div>}>
          {renderPageButtons()}
        </Document>
      ) : (
        renderPageButtons()
      )}
    </div>
  );
}
