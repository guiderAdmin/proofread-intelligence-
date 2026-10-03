"use client";

import React, { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import {
  ZoomIn,
  ZoomOut,
  Circle,
  Square,
  Globe,
  Trash2,
  Check,
  Search,
  RefreshCw,
  FileText,
  MousePointer,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  Sparkles,
  X,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ListPlus
} from "lucide-react";
import { ProofreaderIssue, CustomMark, ProofreaderPageData } from "@/types/proofreader";
import IssueList from "./IssueList";
import LeaderLine from "./LeaderLine";

import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/esm/Page/TextLayer.css";

// Configure PDFjs worker for client-side parsing
if (typeof window !== "undefined") {
  pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.js`;
}

interface ReviewStageProps {
  selectedFile: {
    name: string;
    subject: string;
    size: string;
    pages: number;
    eta: string;
    rawFile?: File;
  } | null;
  issues: ProofreaderIssue[];
  setIssues: React.Dispatch<React.SetStateAction<ProofreaderIssue[]>>;
  customMarks: CustomMark[];
  setCustomMarks: React.Dispatch<React.SetStateAction<CustomMark[]>>;
  currentPage: number;
  setCurrentPage: (page: number) => void;
  activeIssueId: number | null;
  setActiveIssueId: (id: number | null) => void;
  pages?: ProofreaderPageData[];
  onIssueStatus?: (issue: ProofreaderIssue, status: "accepted" | "dismissed") => Promise<void>;
  onNext: () => void;
  isRefiningIssues?: boolean;
}

export function ReviewStage({
  selectedFile,
  issues,
  setIssues,
  customMarks,
  setCustomMarks,
  currentPage,
  setCurrentPage,
  activeIssueId,
  setActiveIssueId,
  pages = [],
  onIssueStatus,
  onNext,
  isRefiningIssues = false,
}: ReviewStageProps) {
  const [activeTool, setActiveTool] = useState<"circle" | "square" | "select">("select");
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [activeRightTab, setActiveRightTab] = useState<"automated" | "manual">("automated");

  // Wikipedia Search
  const [onlineSearchQuery, setOnlineSearchQuery] = useState("");
  const [onlineSearchResults, setOnlineSearchResults] = useState<Array<{ title: string; snippet: string; url: string }>>([]);
  const [isSearchingOnline, setIsSearchingOnline] = useState(false);

  // Drawing selection coordinates
  const [drawingStart, setDrawingStart] = useState<{ x: number; y: number } | null>(null);
  const [drawingCurrent, setDrawingCurrent] = useState<{ x: number; y: number } | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  // Track actual PDF page dimensions for pixel-accurate overlay positioning.
  // The container height is computed dynamically so bbox percentages align
  // exactly with the rendered page content (instead of the old hardcoded 812px
  // which caused ±4 px drift on A4 pages).
  const [pageDims, setPageDims] = useState<{ w: number; h: number } | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const totalPages = numPages || (pages.length > 0 ? pages.length : selectedFile?.pages || 1);
  const CANVAS_WIDTH = 580;
  const containerHeight = pageDims
    ? Math.round((pageDims.h / pageDims.w) * CANVAS_WIDTH)
    : 812;

  // Comment prompt input state
  const [pendingSelection, setPendingSelection] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [newCommentText, setNewCommentText] = useState("");
  // Viewport-absolute anchor for the comment popup (computed at mouseUp time)
  // so the portal can use fixed positioning that is never clipped by overflow.
  const popupAnchorRef = useRef<{ left: number; top: number; right: number; bottom: number } | null>(null);

  // Sidebar Ref system for LeaderLines
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Record<number, HTMLElement | null>>({});
  const markCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const [activeHighlightEl, setActiveHighlightEl] = useState<HTMLElement | null>(null);
  const [activeMarkId, setActiveMarkId] = useState<string | null>(null);

  // We need the root ref on the main container
  const mainContainerRef = useRef<HTMLDivElement>(null);

  const pageContainerRef = useRef<HTMLDivElement>(null);
  const activeIssue = issues.find((i) => i.id === activeIssueId);

  // Keep leader line element in sync
  useEffect(() => {
    if (activeRightTab === "automated" && activeIssueId) {
      const timer = setTimeout(() => {
        const el = document.getElementById(`issue-box-${activeIssueId}`);
        setActiveHighlightEl(el);
      }, 50);
      return () => clearTimeout(timer);
    } else if (activeRightTab === "manual" && activeMarkId) {
      const timer = setTimeout(() => {
        const el = document.getElementById(`mark-box-${activeMarkId}`);
        setActiveHighlightEl(el);
      }, 50);
      return () => clearTimeout(timer);
    } else {
      setActiveHighlightEl(null);
    }
  }, [activeIssueId, activeMarkId, activeRightTab, currentPage, issues, customMarks]);

  const handleOnlineSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onlineSearchQuery.trim()) return;

    setIsSearchingOnline(true);
    try {
      const response = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(onlineSearchQuery)}&utf8=&format=json&origin=*`);
      const data = await response.json();
      
      if (data.query && data.query.search) {
        const results = data.query.search.slice(0, 5).map((item: any) => ({
          title: item.title,
          snippet: item.snippet.replace(/<\/?[^>]+(>|$)/g, "") + "...",
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`
        }));
        
        if (results.length === 0) {
          setOnlineSearchResults([{ title: "No results found", snippet: "Try adjusting your search query.", url: "#" }]);
        } else {
          setOnlineSearchResults(results);
        }
      }
    } catch (err: any) {
      console.warn("Search failed:", err.message);
      setOnlineSearchResults([{ title: "Search Error", snippet: "Failed to connect to the internet search API.", url: "#" }]);
    } finally {
      setIsSearchingOnline(false);
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!pageContainerRef.current) return;

    const rect = pageContainerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    setDrawingStart({ x, y });
    setDrawingCurrent({ x, y });
    setIsDrawing(true);
    setPendingSelection(null);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawing || !drawingStart || !pageContainerRef.current) return;

    const rect = pageContainerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    setDrawingCurrent({ x, y });
  };

  const handleMouseUp = () => {
    if (!isDrawing || !drawingStart || !drawingCurrent) return;
    setIsDrawing(false);

    const w = Math.abs(drawingStart.x - drawingCurrent.x);
    const h = Math.abs(drawingStart.y - drawingCurrent.y);

    if (w < 1.0 && h < 1.0) {
      setDrawingStart(null);
      setDrawingCurrent(null);
      return;
    }

    const x = Math.min(drawingStart.x, drawingCurrent.x);
    const y = Math.min(drawingStart.y, drawingCurrent.y);
    const finalW = Math.max(2, w);
    const finalH = Math.max(2, h);

    // Compute the viewport-absolute bounding box of the drawn selection so
    // the popup portal can use fixed positioning (never clipped by overflow).
    if (pageContainerRef.current) {
      const rect = pageContainerRef.current.getBoundingClientRect();
      popupAnchorRef.current = {
        left:   rect.left   + (x / 100) * rect.width,
        top:    rect.top    + (y / 100) * rect.height,
        right:  rect.left   + ((x + finalW) / 100) * rect.width,
        bottom: rect.top    + ((y + finalH) / 100) * rect.height,
      };
    }

    setPendingSelection({ x, y, w: finalW, h: finalH });
    setDrawingStart(null);
    setDrawingCurrent(null);
  };

  const saveCustomMark = () => {
    if (!pendingSelection || !newCommentText.trim()) return;

    const newMark: CustomMark = {
      id: `mark-${Date.now()}`,
      type: activeTool === "select" ? "highlight" : (activeTool as "circle" | "square"),
      x: pendingSelection.x,
      y: pendingSelection.y,
      w: pendingSelection.w,
      h: pendingSelection.h,
      comment: newCommentText,
      page: currentPage,
    };

    setCustomMarks((prev) => [...prev, newMark]);
    setPendingSelection(null);
    setNewCommentText("");
    setActiveTool("select");
    setActiveRightTab("manual");
  };

  const deleteMark = (id: string) => {
    setCustomMarks((prev) => prev.filter((m) => m.id !== id));
  };

  const handleResolve = async (issueId: number) => {
    const issue = issues.find((item) => item.id === issueId);
    if (!issue) return;
    setIssues((prev) =>
      prev.map((i) => (i.id === issueId ? { ...i, resolved: true } : i))
    );
    try {
      await onIssueStatus?.(issue, "accepted");
      goToNextIssue(issueId);
    } catch (error: any) {
      setIssues((prev) => prev.map((i) => (i.id === issueId ? { ...i, resolved: false } : i)));
      window.alert(error.message || "Could not save this review decision");
    }
  };

  const handleIgnore = async (issueId: number) => {
    const issue = issues.find((item) => item.id === issueId);
    if (!issue) return;
    setIssues((prev) =>
      prev.map((i) => (i.id === issueId ? { ...i, ignored: true } : i))
    );
    try {
      await onIssueStatus?.(issue, "dismissed");
      goToNextIssue(issueId);
    } catch (error: any) {
      setIssues((prev) => prev.map((i) => (i.id === issueId ? { ...i, ignored: false } : i)));
      window.alert(error.message || "Could not save this review decision");
    }
  };

  const goToNextIssue = (currentId: number) => {
    const currentIndex = issues.findIndex(i => i.id === currentId);
    for (let i = currentIndex + 1; i < issues.length; i++) {
      if (!issues[i].resolved && !issues[i].ignored) {
        const nextIssue = issues[i];
        setActiveIssueId(nextIssue.id);
        const nextPage = nextIssue.page ?? nextIssue.pageIndex;
        if (nextPage && nextPage !== currentPage) {
          setCurrentPage(nextPage);
          setTimeout(() => scrollToIssueBox(nextIssue.id), 400);
        } else {
          scrollToIssueBox(nextIssue.id);
        }
        return;
      }
    }
    setActiveIssueId(null);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") setCurrentPage(Math.max(1, currentPage - 1));
      if (event.key === "ArrowRight") setCurrentPage(Math.min(totalPages, currentPage + 1));
      if ((event.key === "a" || event.key === "A") && activeIssueId) void handleResolve(activeIssueId);
      if ((event.key === "x" || event.key === "X") && activeIssueId) void handleIgnore(activeIssueId);
      if (event.key === "j" || event.key === "k") {
        const index = issues.findIndex((item) => item.id === activeIssueId);
        const nextIndex = event.key === "j" ? Math.min(issues.length - 1, index + 1) : Math.max(0, index - 1);
        const next = issues[nextIndex];
        if (next) {
          setActiveIssueId(next.id);
          const nextPage = next.page ?? next.pageIndex;
          if (nextPage) setCurrentPage(nextPage);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  // Handlers intentionally refresh with the current review state on each change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIssueId, currentPage, issues, totalPages]);

  /** Scroll only the PDF canvas viewport to center the issue box — never scrolls the outer layout. */
  const scrollToIssueBox = (issueId: number) => {
    const el = document.getElementById(`issue-box-${issueId}`);
    if (!el) return;
    const scrollParent = el.closest('.overflow-auto') as HTMLElement | null;
    if (!scrollParent) return;
    const elRect = el.getBoundingClientRect();
    const parentRect = scrollParent.getBoundingClientRect();
    scrollParent.scrollTo({
      top: scrollParent.scrollTop + elRect.top - parentRect.top - parentRect.height / 2 + elRect.height / 2,
      behavior: 'smooth'
    });
  };

  const scrollToMarkBox = (markId: string) => {
    const el = document.getElementById(`mark-box-${markId}`);
    if (!el) return;
    const scrollParent = el.closest('.overflow-auto') as HTMLElement | null;
    if (!scrollParent) return;
    const elRect = el.getBoundingClientRect();
    const parentRect = scrollParent.getBoundingClientRect();
    scrollParent.scrollTo({
      top: scrollParent.scrollTop + elRect.top - parentRect.top - parentRect.height / 2 + elRect.height / 2,
      behavior: 'smooth'
    });
  };


  const [fileUrl, setFileUrl] = useState<string | null>(null);
  
  React.useEffect(() => {
    if (selectedFile?.rawFile) {
      const url = URL.createObjectURL(selectedFile.rawFile);
      setFileUrl(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    } else {
      setFileUrl(null);
    }
  }, [selectedFile]);

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  const pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);

  return (
    <div ref={mainContainerRef} className="flex h-full w-full relative z-10 font-sans bg-white flex-grow overflow-hidden min-h-0 rounded-2xl border border-slate-200/80 shadow-[0_4px_24px_rgba(0,0,0,0.04)]">
      
      {/* Leader Line for Active Issue or Mark */}
      {(activeIssueId && activeRightTab === "automated") || (activeMarkId && activeRightTab === "manual") ? (
        <LeaderLine
          rootRef={mainContainerRef}
          fromElement={activeHighlightEl}
          toElement={activeRightTab === "automated" ? cardRefs.current[activeIssueId!] : markCardRefs.current[activeMarkId!]}
          color={activeRightTab === "automated" ? "#ef4444" : "#a855f7"} // Red for AI, Purple for Manual
        />
      ) : null}
      {/* Left Column removed statically. PDF previews now render in the main sidebar. */}

      {/* Center PDF Canvas Viewport */}
      <div className="flex-1 bg-slate-100/40 flex flex-col overflow-hidden relative border-r border-slate-200/60">
        
        {/* PDF Toolbar — Seamless Top Strip */}
        <div className="bg-white border-b border-slate-200/80 px-4 flex justify-between items-center shrink-0 z-10 h-12">
          <div className="flex items-center gap-2.5">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Annotations:</span>
            <div className="flex bg-slate-100/80 p-0.5 rounded-lg border border-slate-200/70 gap-0.5">
              {[
                { id: "circle", label: "Circle", icon: Circle },
                { id: "square", label: "Square", icon: Square },
                { id: "select", label: "Highlight", icon: MousePointer }
              ].map(tool => (
                <button
                  key={tool.id}
                  onClick={() => setActiveTool(tool.id as any)}
                  className={`px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 text-[10px] font-bold ${
                    activeTool === tool.id 
                      ? "bg-white text-brand-600 shadow-xs ring-1 ring-slate-200/80 font-black" 
                      : "text-slate-500 hover:text-slate-800 hover:bg-white/60"
                  }`}
                >
                  <tool.icon className="h-3.5 w-3.5" />
                  <span>{tool.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {/* Zoom Controls */}
            <div className="flex items-center bg-slate-100/80 border border-slate-200/70 rounded-lg p-0.5">
              <button onClick={() => setZoomLevel((z) => Math.max(50, z - 10))} className="p-1 hover:bg-white rounded-md transition-colors text-slate-500 hover:text-slate-800">
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <span className="text-[10px] font-bold text-slate-700 font-mono px-2">{zoomLevel}%</span>
              <button onClick={() => setZoomLevel((z) => Math.min(150, z + 10))} className="p-1 hover:bg-white rounded-md transition-colors text-slate-500 hover:text-slate-800">
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Page Navigation */}
            <div className="flex items-center bg-slate-100/80 border border-slate-200/70 rounded-lg p-0.5">
              <button
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(currentPage - 1)}
                className="p-1 hover:bg-white rounded-md disabled:opacity-30 disabled:hover:bg-transparent transition-colors text-slate-600"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="text-[10px] font-bold text-slate-700 font-mono px-2 min-w-[76px] text-center">
                Page {currentPage} / {totalPages}
              </span>
              <button
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage(currentPage + 1)}
                className="p-1 hover:bg-white rounded-md disabled:opacity-30 disabled:hover:bg-transparent transition-colors text-slate-600"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Scrollable Canvas Area */}
        <div className="flex-1 overflow-auto p-8 flex items-start justify-center min-h-0 relative">
          <div className="absolute inset-0 bg-[radial-gradient(#e2e8f0_1px,transparent_1px)] [background-size:16px_16px] pointer-events-none" />
          
          <div
            ref={pageContainerRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            className="bg-white border border-slate-200 relative select-none shrink-0 shadow-md rounded overflow-hidden"
            style={{
              width: `${CANVAS_WIDTH}px`,
              height: `${containerHeight}px`,
              zoom: zoomLevel / 100,
              cursor: activeTool !== "select" ? "crosshair" : "default",
            }}
          >
            {fileUrl ? (
              <div className="absolute inset-0 z-0 flex items-center justify-center bg-slate-50">
                <Document
                  file={fileUrl}
                  onLoadSuccess={onDocumentLoadSuccess}
                  loading={<div className="text-slate-400 font-mono text-xs animate-pulse">Loading PDF...</div>}
                >
                  <Page
                    pageNumber={currentPage}
                    width={CANVAS_WIDTH}
                    renderTextLayer={true}
                    renderAnnotationLayer={false}
                    loading={
                      <div className="absolute inset-0 bg-white flex flex-col justify-start p-8">
                        <div className="w-full h-full border-2 border-slate-100 rounded-xl p-8 flex flex-col gap-4 animate-pulse">
                          <div className="h-4 bg-slate-200/80 rounded-full w-3/4 mb-4" />
                          <div className="h-3 bg-slate-100 rounded-full w-5/6" />
                          <div className="h-3 bg-slate-100 rounded-full w-full" />
                          <div className="h-3 bg-slate-100 rounded-full w-2/3" />
                          <div className="h-3 bg-slate-100 rounded-full w-1/3 mb-4" />
                          <div className="h-3 bg-slate-100 rounded-full w-3/4" />
                          <div className="h-3 bg-slate-100 rounded-full w-4/5" />
                          <div className="h-3 bg-slate-100 rounded-full w-1/2" />
                          <div className="h-3 bg-slate-100 rounded-full w-2/5" />
                        </div>
                      </div>
                    }
                    onLoadSuccess={(page: any) => {
                      const vp = page.getViewport ? page.getViewport({ scale: 1 }) : null;
                      const w = vp?.width || page?.originalWidth || page?.width;
                      const h = vp?.height || page?.originalHeight || page?.height;
                      if (w && h) {
                        setPageDims({ w, h });
                      }
                    }}
                  />
                </Document>
              </div>
            ) : (
              <div className="absolute inset-0 bg-white flex flex-col justify-start p-8 z-0">
                <div className="w-full h-full border-2 border-slate-100 rounded-xl p-8 flex flex-col gap-4 animate-pulse">
                  <div className="h-4 bg-slate-200/80 rounded-full w-3/4 mb-4" />
                  <div className="h-3 bg-slate-100 rounded-full w-5/6" />
                  <div className="h-3 bg-slate-100 rounded-full w-full" />
                  <div className="h-3 bg-slate-100 rounded-full w-2/3" />
                  <div className="h-3 bg-slate-100 rounded-full w-1/3 mb-4" />
                  <div className="h-3 bg-slate-100 rounded-full w-3/4" />
                  <div className="h-3 bg-slate-100 rounded-full w-4/5" />
                  <div className="h-3 bg-slate-100 rounded-full w-1/2" />
                  <div className="h-3 bg-slate-100 rounded-full w-2/5" />
                </div>
              </div>
            )}


            {/* Render ALL issue bbox overlays for current page */}
            {!isRefiningIssues && issues.filter(issue =>
              !issue.ignored &&
              (issue.page ?? issue.pageIndex) === currentPage &&
              issue.bbox
            ).map((issue) => {
              const isActive = issue.id === activeIssueId;
              const isResolved = issue.resolved;
              return (
                <div
                  id={`issue-box-${issue.id}`}
                  key={issue.id}
                  onMouseDown={(e) => e.stopPropagation()}
                  onMouseUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveRightTab("automated");
                    setActiveIssueId(issue.id);
                    setTimeout(() => scrollToIssueBox(issue.id), 50);
                  }}
                  className={`absolute z-10 cursor-pointer transition-all duration-200 ${
                    isResolved
                      ? "border-2 border-emerald-500 bg-emerald-50/20"
                      : isActive
                      ? "border-2 border-brand-500 bg-brand-50/20"
                      : "border border-red-400 bg-red-50/10 hover:border-red-500 hover:bg-red-50/25"
                  }`}
                  style={{
                    left: `${issue.bbox!.x}%`,
                    top: `${issue.bbox!.y}%`,
                    width: `${issue.bbox!.w}%`,
                    height: `${issue.bbox!.h}%`,
                  }}
                  title={`[${issue.id}] ${issue.category}: ${issue.originalText}`}
                >
                </div>
              );
            })}

            {/* Render temporary drawing rectangle */}
            {isDrawing && drawingStart && drawingCurrent && (
              <div
                className="absolute border border-dashed border-brand-500 bg-brand-50/20 z-20"
                style={{
                  left: `${Math.min(drawingStart.x, drawingCurrent.x)}%`,
                  top: `${Math.min(drawingStart.y, drawingCurrent.y)}%`,
                  width: `${Math.abs(drawingStart.x - drawingCurrent.x)}%`,
                  height: `${Math.abs(drawingStart.y - drawingCurrent.y)}%`,
                }}
              />
            )}

            {/* Render Saved Annotations */}
            {customMarks.filter((m) => m.page === currentPage).map((mark) => {
              const globalIndex = customMarks.findIndex(m => m.id === mark.id) + 1;
              return (
                <div
                  id={`mark-box-${mark.id}`}
                  key={mark.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveRightTab("manual");
                    setActiveMarkId(mark.id);
                    setTimeout(() => scrollToMarkBox(mark.id), 50);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onMouseUp={(e) => e.stopPropagation()}
                  className={`absolute ${
                    mark.type === "circle" 
                      ? "border-[2.5px] border-brand-500 bg-brand-500/10 rounded-full shadow-[0_0_15px_rgba(14,165,233,0.3)]" 
                      : mark.type === "highlight"
                      ? "bg-yellow-300/40 border-b-2 border-yellow-500 mix-blend-multiply shadow-[0_4px_15px_rgba(234,179,8,0.2)]"
                      : "border-[2.5px] border-purple-500 bg-purple-500/10 shadow-[0_0_15px_rgba(168,85,247,0.3)]"
                  } z-20 flex items-start justify-end group transition-all duration-300 cursor-pointer ${
                    activeMarkId === mark.id && activeRightTab === "manual" ? "ring-2 ring-purple-500 ring-offset-1" : ""
                  }`}
                  style={{
                    left: `${mark.x}%`,
                    top: `${mark.y}%`,
                    width: `${mark.w}%`,
                    height: `${mark.h}%`,
                  }}
                >
                  <div className={`absolute -top-3 -right-3 h-6 min-w-[24px] px-1.5 rounded-md border flex items-center justify-center text-[10px] font-black shadow-lg backdrop-blur-md transition-transform group-hover:scale-110 ${
                    mark.type === "circle" ? "bg-brand-600 text-white border-brand-500" : mark.type === "highlight" ? "bg-yellow-400 text-yellow-950 border-yellow-300" : "bg-purple-600 text-white border-purple-500"
                  }`}>
                    M{globalIndex}
                  </div>
                </div>
              );
            })}

            {/* Comment popup rendered via portal so it is NEVER clipped by
                the overflow-hidden page canvas container. Fixed positioning
                means it stays in the viewport at all times. */}
            {pendingSelection && popupAnchorRef.current && typeof window !== "undefined" &&
              createPortal(
                (() => {
                  const POPUP_W = 224; // w-56 = 14rem = 224px
                  const POPUP_H = 168; // approx height of the popup
                  const GAP = 8;
                  const vw = window.innerWidth;
                  const vh = window.innerHeight;
                  const anchor = popupAnchorRef.current!;

                  // Prefer below the selection; flip above if not enough space
                  let top = anchor.bottom + GAP;
                  if (top + POPUP_H > vh - GAP) top = anchor.top - POPUP_H - GAP;
                  // Ensure never above the viewport
                  top = Math.max(GAP, top);

                  // Prefer aligned to the left edge of the selection; flip if overflows right
                  let left = anchor.left;
                  if (left + POPUP_W > vw - GAP) left = anchor.right - POPUP_W;
                  // Ensure never off the left edge
                  left = Math.max(GAP, left);

                  return (
                    <div
                      className="fixed bg-white border border-slate-200 p-4 shadow-xl z-[9999] flex flex-col gap-2 rounded-lg border-t-2 border-t-brand-500 animate-in zoom-in-95 duration-200"
                      style={{ width: POPUP_W, top, left }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onMouseUp={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">Add annotation note</span>
                      <textarea
                        autoFocus
                        value={newCommentText}
                        onChange={(e) => setNewCommentText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveCustomMark();
                          if (e.key === "Escape") { setPendingSelection(null); setNewCommentText(""); }
                        }}
                        placeholder="Enter comment… (Ctrl+Enter to save)"
                        className="w-full p-2 border border-slate-200 text-[10px] focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 resize-none h-16 rounded-md font-sans bg-slate-50/50"
                      />
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => { setPendingSelection(null); setNewCommentText(""); }}
                          className="px-2.5 py-1 text-[9px] border border-slate-200 rounded text-slate-500 hover:bg-slate-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={saveCustomMark}
                          className="px-2.5 py-1 text-[9px] bg-slate-900 hover:bg-slate-800 text-white font-bold rounded"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  );
                })()
              , document.body)
            }
          </div>
        </div>
      </div>

      {/* Right Column: AI Resolution Panel */}
      <div className="w-80 bg-white border-l border-slate-200/60 flex flex-col h-full shrink-0 shadow-[-4px_0_24px_rgba(0,0,0,0.02)] z-30">
        
        {/* Sidebar tabs */}
        {/* Sidebar Header Tabs — Matching Top Strip */}
        <div className="flex border-b border-slate-200/80 shrink-0 text-[10px] font-bold text-slate-400 h-12 items-stretch bg-white">
          <button
            onClick={() => setActiveRightTab("automated")}
            className={`flex-1 flex items-center justify-center border-b-2 transition-all uppercase tracking-wider ${
              activeRightTab === "automated" ? "border-b-brand-500 text-brand-700 bg-white font-black" : "border-b-transparent hover:bg-slate-50 text-slate-500"
            }`}
          >
            Automated Checks ({issues.filter(i => !i.resolved && !i.ignored).length})
          </button>
          <button
            onClick={() => setActiveRightTab("manual")}
            className={`flex-1 flex items-center justify-center border-b-2 transition-all uppercase tracking-wider ${
              activeRightTab === "manual" ? "border-b-brand-500 text-brand-700 bg-white font-black" : "border-b-transparent hover:bg-slate-50 text-slate-500"
            }`}
          >
            Manual Marks ({customMarks.length})
          </button>
        </div>

        {/* Tab 1: Automated Queue & Web Search */}
        {activeRightTab === "automated" && (
          <div className="flex-grow flex flex-col min-h-0">
            {/* Automated Issues Queue */}
            <div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar">
              <IssueList 
                issues={issues}
                selectedId={activeIssueId}
                onSelect={(id) => {
                  setActiveIssueId(id);
                  const issue = issues.find(i => i.id === id);
                  const issuePage = issue?.page ?? issue?.pageIndex;
                  if (issuePage && issuePage !== currentPage) {
                    setCurrentPage(issuePage);
                  }
                }}
                onStatus={(id, status) => {
                  if (status === "accepted") {
                    void handleResolve(id);
                  } else if (status === "dismissed") {
                    void handleIgnore(id);
                  } else if (status === "open") {
                    // Reset: undo resolved/ignored locally and tell backend
                    setIssues((prev) =>
                      prev.map((i) => (i.id === id ? { ...i, resolved: false, ignored: false } : i))
                    );
                    const issue = issues.find(i => i.id === id);
                    if (issue && onIssueStatus) {
                      onIssueStatus(issue, "open" as any);
                    }
                  }
                }}
                cardRefs={cardRefs}
              />
            </div>

          </div>
        )}

        {/* Tab 2: Manual Annotations list */}
        {activeRightTab === "manual" && (
          <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0 custom-scrollbar">
            <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider block">Manual Annotations</span>
            <div className="space-y-2.5">
              {customMarks.map((mark, idx) => {
                const isActive = activeMarkId === mark.id;
                return (
                <div
                  key={mark.id}
                  id={`sidebar-mark-${mark.id}`}
                  ref={(el) => { markCardRefs.current[mark.id] = el; }}
                  onClick={() => {
                    setActiveMarkId(mark.id);
                    if (currentPage !== mark.page) setCurrentPage(mark.page);
                  }}
                  className={`relative p-4 bg-white border flex flex-col gap-2 rounded-xl shadow-sm cursor-pointer hover:shadow-md hover:shadow-orange-500/20 hover:border-brand-200 transition-all duration-300 overflow-hidden ${
                    isActive ? "border-purple-500 ring-1 ring-purple-500/30 shadow-md transform -translate-y-0.5" : "border-slate-200/80 transform hover:-translate-y-1"
                  }`}
                >
                  <div className={`absolute top-0 left-0 w-1 h-full ${
                    mark.type === "circle" ? "bg-brand-500" : mark.type === "highlight" ? "bg-yellow-400" : "bg-purple-500"
                  }`} />
                  
                  <div className="flex justify-between items-start pl-1">
                    <div className="flex items-center gap-2.5">
                      <div className={`h-6 w-6 rounded-md flex items-center justify-center text-[10px] font-black shadow-sm ${
                        mark.type === "circle" ? "bg-brand-50 text-brand-600 border border-brand-200" : mark.type === "highlight" ? "bg-yellow-50 text-yellow-700 border border-yellow-200" : "bg-purple-50 text-purple-600 border border-purple-200"
                      }`}>
                        M{idx + 1}
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[10px] font-bold text-slate-800 uppercase tracking-wider">
                          {mark.type === "highlight" ? "Text Highlight" : `${mark.type} Mark`}
                        </span>
                        <span className="text-[9px] text-slate-400 font-medium tracking-wide">
                          Page {mark.page}
                        </span>
                      </div>
                    </div>
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteMark(mark.id);
                      }} 
                      className="text-slate-300 hover:text-red-500 hover:bg-red-50 p-1.5 rounded-md transition-all active:scale-95"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  
                  <div className="pl-1 pt-1.5">
                    <div className="bg-slate-50/80 border border-slate-100 p-2.5 rounded-lg">
                      <p className="text-[11px] text-slate-600 leading-relaxed font-medium break-all whitespace-pre-wrap">{mark.comment}</p>
                    </div>
                  </div>
                </div>
                );
              })}
              
              {customMarks.length === 0 && (
                <div className="text-center py-10 text-slate-400 border border-dashed border-slate-200 p-4 rounded-lg bg-slate-50/50">
                  <p className="text-[9px] italic">No manual markings drawn yet. Drag circle or square tools on canvas to annotate.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Action footer button */}
        <div className="p-4 border-t border-slate-200 shrink-0 bg-white z-10 flex flex-col gap-2">
          {activeIssue ? (
             <div className="flex items-center justify-between px-1">
               <button 
                 onClick={() => goToNextIssue(activeIssue.id)} 
                 className="text-[10px] font-bold text-slate-500 hover:text-slate-800 uppercase tracking-wider flex items-center gap-0.5 transition-colors"
               >
                 Skip Flag <ChevronRight className="h-3.5 w-3.5" />
               </button>
             </div>
          ) : (
             <button
               onClick={onNext}
               className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-2.5 rounded-lg flex items-center justify-center gap-1.5 transition-all shadow-sm uppercase tracking-wider text-xs active:scale-[0.98]"
             >
               <span>Finalize & Export</span>
               <ArrowRight className="h-4 w-4" />
             </button>
          )}
        </div>

      </div>
    </div>
  );
}
