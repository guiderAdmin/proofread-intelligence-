"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, ChevronDown, GripHorizontal, Loader2, MousePointer2, Send, Sparkles, Trash2, X } from "lucide-react";
import Image from "next/image";

type AgentMessage = {
  role: "user" | "assistant";
  content: string;
  pageNumber?: number;
  hasCapture?: boolean;
};

interface AgenticBotProps {
  bookId: string | null;
  pageNumber: number;
  stage: string;
  projectTitle?: string;
  activeIssueUid?: string;
  sidebarIssueMap?: Array<{ number: number; uid: string; page: number }>;
  onNavigatePage?: (pageNumber: number) => void;
  onAnalysisAction?: () => void | Promise<void>;
}

type Point = { x: number; y: number };
type CaptureRect = { left: number; top: number; width: number; height: number };

const COLLAPSED_WIDTH = 48;
const COLLAPSED_HEIGHT = 48;
const PANEL_WIDTH = 374;
const PANEL_HEIGHT = 540;
const PROCESS_STEPS = ["Gathering live page context", "Reviewing issues and project memory", "Preparing a grounded response"];

function dockPosition(): Point | null {
  if (typeof document === "undefined") return null;
  const dock = document.getElementById("proof-intelligence-dock");
  if (!dock) return null;
  const bounds = dock.getBoundingClientRect();
  return {
    x: bounds.left + (bounds.width - COLLAPSED_WIDTH) / 2,
    y: bounds.top + (bounds.height - COLLAPSED_HEIGHT) / 2,
  };
}
function clampPosition(point: Point, expanded: boolean, measured?: { width: number; height: number }): Point {
  const width = measured?.width || (expanded ? Math.min(PANEL_WIDTH, window.innerWidth - 24) : Math.min(COLLAPSED_WIDTH, window.innerWidth - 24));
  const height = measured?.height || (expanded ? Math.min(PANEL_HEIGHT, window.innerHeight - 24) : COLLAPSED_HEIGHT);
  return {
    x: Math.max(12, Math.min(window.innerWidth - width - 12, point.x)),
    y: Math.max(12, Math.min(window.innerHeight - height - 12, point.y)),
  };
}

function readableLine(value: string) {
  return value
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function ResponseText({ content }: { content: string }) {
  const lines = String(content || "").split(/\r?\n/);
  return (
    <div className="space-y-1.5">
      {lines.map((raw, index) => {
        const text = readableLine(raw);
        if (!text || /^-{3,}$/.test(text)) return text ? null : <div key={index} className="h-1" />;
        const bullet = text.match(/^[-*•]\s+(.+)$/);
        if (bullet) return <div key={index} className="flex items-start gap-2"><span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400" /><span>{bullet[1]}</span></div>;
        const numbered = text.match(/^(\d+)[.)]\s+(.+)$/);
        if (numbered) return <div key={index} className="flex items-start gap-2"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-orange-100 text-[9px] font-black text-brand-700">{numbered[1]}</span><span>{numbered[2]}</span></div>;
        return <p key={index}>{text}</p>;
      })}
    </div>
  );
}

function cropPdfCanvas(rect: CaptureRect): string | null {
  const canvases = Array.from(document.querySelectorAll(".react-pdf__Page canvas")) as HTMLCanvasElement[];
  let best: { canvas: HTMLCanvasElement; overlap: number; bounds: DOMRect } | null = null;
  for (const canvas of canvases) {
    const bounds = canvas.getBoundingClientRect();
    const overlapW = Math.max(0, Math.min(rect.left + rect.width, bounds.right) - Math.max(rect.left, bounds.left));
    const overlapH = Math.max(0, Math.min(rect.top + rect.height, bounds.bottom) - Math.max(rect.top, bounds.top));
    const overlap = overlapW * overlapH;
    if (overlap > (best?.overlap || 0)) best = { canvas, overlap, bounds };
  }
  if (!best || best.overlap < 25) return null;

  const left = Math.max(rect.left, best.bounds.left);
  const top = Math.max(rect.top, best.bounds.top);
  const right = Math.min(rect.left + rect.width, best.bounds.right);
  const bottom = Math.min(rect.top + rect.height, best.bounds.bottom);
  const scaleX = best.canvas.width / best.bounds.width;
  const scaleY = best.canvas.height / best.bounds.height;
  const sx = Math.max(0, (left - best.bounds.left) * scaleX);
  const sy = Math.max(0, (top - best.bounds.top) * scaleY);
  const sw = Math.max(1, (right - left) * scaleX);
  const sh = Math.max(1, (bottom - top) * scaleY);
  const maxSide = 2000;
  const outputScale = Math.min(1, maxSide / Math.max(sw, sh));
  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.round(sw * outputScale));
  output.height = Math.max(1, Math.round(sh * outputScale));
  const context = output.getContext("2d");
  if (!context) return null;
  context.drawImage(best.canvas, sx, sy, sw, sh, 0, 0, output.width, output.height);
  return output.toDataURL("image/jpeg", 0.82);
}

/**
 * Capture the largest rendered instance of the active PDF page. Review view can
 * contain both a thumbnail and the main page, so choosing by rendered area
 * prevents the assistant from receiving a tiny sidebar image. The snapshot is
 * created at send time, making the visual evidence match what the user is
 * currently viewing rather than a stale server-side extraction.
 */
function captureActivePdfPage(pageNumber: number): string | null {
  const exactSelector = `.react-pdf__Page[data-page-number="${pageNumber}"] canvas`;
  const candidates = Array.from(document.querySelectorAll(exactSelector)) as HTMLCanvasElement[];
  const source = candidates
    .filter((canvas) => {
      const bounds = canvas.getBoundingClientRect();
      return canvas.width > 0 && canvas.height > 0 && bounds.width > 0 && bounds.height > 0;
    })
    .sort((a, b) => {
      const aBounds = a.getBoundingClientRect();
      const bBounds = b.getBoundingClientRect();
      return (bBounds.width * bBounds.height) - (aBounds.width * aBounds.height);
    })[0];
  if (!source) return null;

  const maxSide = 2000;
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.round(source.width * scale));
  output.height = Math.max(1, Math.round(source.height * scale));
  const context = output.getContext("2d");
  if (!context) return null;
  context.drawImage(source, 0, 0, source.width, source.height, 0, 0, output.width, output.height);
  return output.toDataURL("image/jpeg", 0.9);
}

function requestsFullPageVisual(message: string) {
  const text = message.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    /\b(?:full|whole|entire)\s+(?:current\s+|this\s+)?page\b/.test(text) ||
    /\b(?:analy[sz]e|review|inspect|describe)\s+(?:the\s+)?(?:current\s+|this\s+)?page\s*[?.!]*$/.test(text) ||
    /\btell\s+me\s+(?:everything\s+)?about\s+(?:the\s+)?(?:current\s+|this\s+)?page\b/.test(text) ||
    /\bwhat(?:'s|\s+is)\s+(?:shown\s+|there\s+)?on\s+(?:this|the\s+current)\s+page\b/.test(text)
  );
}

export function AgenticBot({ bookId, pageNumber, stage, projectTitle, activeIssueUid, onNavigatePage, onAnalysisAction, sidebarIssueMap }: AgenticBotProps) {
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState("");
  const [selectedText, setSelectedText] = useState("");
  const [captureDataUrl, setCaptureDataUrl] = useState("");
  const [captureMode, setCaptureMode] = useState(false);
  const [isDetailed, setIsDetailed] = useState(false);
  const [captureStart, setCaptureStart] = useState<Point | null>(null);
  const [captureCurrent, setCaptureCurrent] = useState<Point | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [docked, setDocked] = useState(true);
  const [processingStep, setProcessingStep] = useState(0);
  const [pageChanging, setPageChanging] = useState(false);
  const [error, setError] = useState("");
  const [position, setPosition] = useState<Point | null>(null);
  const dragRef = useRef<{ pointer: Point; origin: Point; moved: boolean; size: { width: number; height: number } } | null>(null);
  const suppressClickRef = useRef(false);
  const loadedBookRef = useRef<string | null>(null);
  const lastPdfSelectionRef = useRef("");
  const shellRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousPageRef = useRef(pageNumber);
  const bookVersionRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setMounted(true);
    let attempts = 0;
    const findDockTimer = setInterval(() => {
      const p = dockPosition();
      if (p) {
        setPosition(p);
        clearInterval(findDockTimer);
      } else if (attempts++ > 40) {
        clearInterval(findDockTimer);
      }
    }, 50);
    return () => clearInterval(findDockTimer);
  }, []);

  useLayoutEffect(() => {
    if (!mounted || typeof window === "undefined") return;
    if (docked && !expanded) {
      const p = dockPosition();
      if (p) setPosition(p);
    }
    else setPosition((current) => current ? clampPosition(current, expanded) : null);
  }, [expanded, mounted, docked]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleResize = () => {
      if (docked && !expanded) {
        const p = dockPosition();
        if (p) setPosition(p);
      } else {
        setPosition((current) => current ? clampPosition(current, expanded) : null);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [docked, expanded]);

  useEffect(() => {
    bookVersionRef.current++;
    setMessages([]);
    setSelectedText("");
    setCaptureDataUrl("");
    setBusy(false);
    setHistoryLoading(false);
    setError("");
    lastPdfSelectionRef.current = "";
    loadedBookRef.current = null;
    return () => { bookVersionRef.current++; };
  }, [bookId]);

  useEffect(() => {
    setSelectedText("");
    setCaptureDataUrl("");
    lastPdfSelectionRef.current = "";
    if (previousPageRef.current !== pageNumber) {
      previousPageRef.current = pageNumber;
      setPageChanging(true);
      const timer = window.setTimeout(() => setPageChanging(false), 900);
      return () => window.clearTimeout(timer);
    }
  }, [pageNumber]);

  useEffect(() => {
    if (!busy) {
      setProcessingStep(0);
      return;
    }
    const timer = window.setInterval(() => setProcessingStep((current) => Math.min(current + 1, PROCESS_STEPS.length - 1)), 1200);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    const rememberPdfSelection = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const text = String(selection).replace(/\s+/g, " ").trim().slice(0, 2400);
      if (!text) return;
      const range = selection.getRangeAt(0);
      const common = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer as Element
        : range.commonAncestorContainer.parentElement;
      const inTextLayer = Boolean(common?.closest(".react-pdf__Page__textLayer, .textLayer"));
      const selectionBox = range.getBoundingClientRect();
      const overlapsPdf = Array.from(document.querySelectorAll(".react-pdf__Page")).some((page) => {
        const box = page.getBoundingClientRect();
        return selectionBox.right > box.left && selectionBox.left < box.right && selectionBox.bottom > box.top && selectionBox.top < box.bottom;
      });
      if (inTextLayer || overlapsPdf) lastPdfSelectionRef.current = text;
    };
    document.addEventListener("selectionchange", rememberPdfSelection);
    return () => document.removeEventListener("selectionchange", rememberPdfSelection);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  useEffect(() => {
    const onResize = () => setPosition((current) => {
      if (docked && !expanded) return dockPosition();
      const bounds = shellRef.current?.getBoundingClientRect();
      return current ? clampPosition(current, expanded, bounds) : null;
    });
    window.addEventListener("resize", onResize);
    const dock = document.getElementById("proof-intelligence-dock");
    const observer = dock && typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    if (dock) observer?.observe(dock);
    return () => { window.removeEventListener("resize", onResize); observer?.disconnect(); };
  }, [expanded, docked]);

  if (!mounted) return null;

  const onDragStart = (event: React.PointerEvent) => {
    if (!(event.target as HTMLElement).closest("[data-agent-drag]")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const origin = position || { x: bounds.left, y: bounds.top };
    setPosition(origin);
    dragRef.current = { pointer: { x: event.clientX, y: event.clientY }, origin, moved: false, size: { width: bounds.width, height: bounds.height } };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onDragMove = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.pointer.x;
    const dy = event.clientY - dragRef.current.pointer.y;
    // Allow natural hand/trackpad jitter without turning a click into a drag.
    if (!dragRef.current.moved && Math.hypot(dx, dy) < 8) return;
    dragRef.current.moved = true;
    if (docked) setDocked(false);
    setPosition(clampPosition({
      x: dragRef.current.origin.x + dx,
      y: dragRef.current.origin.y + dy,
    }, expanded, dragRef.current.size));
  };
  const onDragEnd = () => {
    const moved = dragRef.current?.moved;
    dragRef.current = null;
    const bounds = shellRef.current?.getBoundingClientRect();
    const dock = document.getElementById("proof-intelligence-dock")?.getBoundingClientRect();
    const nearDock = !expanded && moved && bounds && dock
      ? bounds.right > dock.left - 24 && bounds.left < dock.right + 24 && bounds.bottom > dock.top - 24 && bounds.top < dock.bottom + 24
      : false;
    if (nearDock) {
      setDocked(true);
      setPosition(dockPosition());
    } else {
      setPosition((current) => current ? clampPosition(current, expanded, bounds) : null);
    }
    if (moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    } else if (!expanded) {
      openAssistant();
    }
  };

  const loadConversation = async () => {
    if (!bookId || loadedBookRef.current === bookId) return;
    loadedBookRef.current = bookId;
    const version = bookVersionRef.current;
    setHistoryLoading(true);
    try {
      const response = await fetch(`/api/agentic-bot?bookId=${encodeURIComponent(bookId)}`, { cache: "no-store" });
      const payload = await response.json();
      if (version !== bookVersionRef.current) return;
      if (!response.ok) throw new Error(payload?.error || "Could not load companion");
      setMessages(payload.messages || []);
    } catch (reason: any) {
      if (version !== bookVersionRef.current) return;
      loadedBookRef.current = null;
      setError(reason.message || "Could not load companion");
    } finally {
      if (version === bookVersionRef.current) setHistoryLoading(false);
    }
  };

  const openAssistant = () => {
    if (suppressClickRef.current) return;
    if (docked) {
      const dock = document.getElementById("proof-intelligence-dock")?.getBoundingClientRect();
      setPosition(clampPosition({ x: (dock?.right || 64) + 14, y: Math.max(12, dock?.top || 24) }, true));
    } else {
      setPosition((current) => current ? clampPosition(current, true) : null);
    }
    setExpanded(true);
    void loadConversation();
  };

  const closeAssistant = () => {
    setExpanded(false);
    if (docked) window.requestAnimationFrame(() => setPosition(dockPosition()));
  };

  const useCurrentSelection = () => {
    const selection = window.getSelection();
    const liveText = String(selection || "").replace(/\s+/g, " ").trim().slice(0, 2400);
    const text = liveText || lastPdfSelectionRef.current;
    if (!text) {
      setError("Select text on the PDF page first.");
      return;
    }
    setSelectedText(text);
    setError("");
  };

  const completeCapture = () => {
    if (!captureStart || !captureCurrent) {
      setCaptureMode(false);
      return;
    }
    const rect = {
      left: Math.min(captureStart.x, captureCurrent.x),
      top: Math.min(captureStart.y, captureCurrent.y),
      width: Math.abs(captureStart.x - captureCurrent.x),
      height: Math.abs(captureStart.y - captureCurrent.y),
    };
    let image: string | null = null;
    try {
      image = rect.width >= 8 && rect.height >= 8 ? cropPdfCanvas(rect) : null;
    } catch {
      image = null;
    }
    setCaptureMode(false);
    setCaptureStart(null);
    setCaptureCurrent(null);
    if (!image) setError("Draw the capture rectangle over the visible PDF page.");
    else {
      setCaptureDataUrl(image);
      setError("");
      setExpanded(true);
    }
  };

  const send = async () => {
    const message = input.trim();
    if (!message || busy || historyLoading) return;
    if (!bookId) {
      setError("Open or start a proofreading project so Proof Intelligence has live context.");
      return;
    }
    const version = bookVersionRef.current;
    const fullPageRequested = requestsFullPageVisual(message) || /\b(?:where|locat\w*|headings?|capitali[sz]\w*|missing|missed|ignored|issues?|errors?)\b/i.test(message);
    let fullPageDataUrl = "";
    if (!captureDataUrl && fullPageRequested) {
      try {
        fullPageDataUrl = captureActivePdfPage(pageNumber) || "";
      } catch {
        fullPageDataUrl = "";
      }
    }
    const visualDataUrl = captureDataUrl || fullPageDataUrl;
    const captureKind = captureDataUrl
      ? "region"
      : fullPageDataUrl
        ? "full_page"
        : fullPageRequested
          ? "full_page_unavailable"
          : "none";
    const optimistic: AgentMessage = { role: "user", content: message, pageNumber, hasCapture: Boolean(visualDataUrl) };
    setMessages((current) => [...current, optimistic]);
    setInput("");
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/agentic-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, pageNumber, message, selectedText, captureDataUrl: visualDataUrl, captureKind, activeIssueUid, sidebarIssueMap, stage, isDetailed }),
      });
      const payload = await response.json();
      if (version !== bookVersionRef.current) return;
      if (!response.ok) throw new Error(payload?.error || "Assistant request failed");
      setMessages((current) => [...current, { role: "assistant", content: payload.answer, pageNumber }]);
      if (payload.action?.kind === "navigate" && Number.isInteger(payload.action.pageNumber)) {
        onNavigatePage?.(payload.action.pageNumber);
      }
      if (["pause", "resume", "reanalyze", "findings_updated"].includes(payload.action?.kind)) await onAnalysisAction?.();
      setCaptureDataUrl("");
      setSelectedText("");
    } catch (reason: any) {
      if (version !== bookVersionRef.current) return;
      setError(reason.message || "Assistant request failed");
    } finally {
      if (version === bookVersionRef.current) setBusy(false);
    }
  };

  const isLeftHalf = position
    ? position.x < (typeof window !== "undefined" ? window.innerWidth / 2 : 500)
    : docked;


  return createPortal(
    <>
      {captureMode && (
        <div
          className="fixed inset-0 cursor-crosshair bg-orange-100/20 backdrop-blur-[1px]"
          style={{ zIndex: 2147483647 }}
          onPointerDown={(event) => { setCaptureStart({ x: event.clientX, y: event.clientY }); setCaptureCurrent({ x: event.clientX, y: event.clientY }); }}
          onPointerMove={(event) => captureStart && setCaptureCurrent({ x: event.clientX, y: event.clientY })}
          onPointerUp={completeCapture}
          onKeyDown={(event) => event.key === "Escape" && setCaptureMode(false)}
          tabIndex={0}
          autoFocus
        >
          <div className="absolute left-1/2 top-5 -translate-x-1/2 rounded-full border border-orange-200 bg-white px-4 py-2 text-xs font-bold text-brand-700 shadow-xl shadow-orange-500/10">
            Drag over the visible PDF region · Esc to cancel
          </div>
          {captureStart && captureCurrent && (
            <div className="absolute border-2 border-brand-500 bg-brand-400/10 shadow-xl" style={{
              left: Math.min(captureStart.x, captureCurrent.x), top: Math.min(captureStart.y, captureCurrent.y),
              width: Math.abs(captureStart.x - captureCurrent.x), height: Math.abs(captureStart.y - captureCurrent.y),
            }} />
          )}
        </div>
      )}

      <div
        ref={shellRef}
        className={`${docked ? "absolute" : "fixed"} ${expanded ? "w-auto" : "h-[48px] w-[48px]"}`}
        style={position
          ? { left: position.x, top: position.y, zIndex: expanded ? 2147483646 : 60, touchAction: "none" }
          : expanded
            ? { right: 20, bottom: 20, zIndex: 2147483646, touchAction: "none" }
            : { right: 24, bottom: 76, zIndex: 60, touchAction: "none", opacity: docked ? 0 : 1, pointerEvents: docked ? "none" : "auto" }}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        {!expanded ? (
          <button
            data-agent-drag
            onClick={(event) => { if (event.detail === 0) openAssistant(); }}
            className={`group relative flex h-[48px] w-[48px] cursor-grab items-center justify-center rounded-full border-[2.5px] border-white bg-gradient-to-br from-orange-300 via-brand-500 to-brand-600 text-white ring-1 ring-orange-300/70 transition-[transform,box-shadow,filter] duration-300 hover:scale-105 hover:brightness-105 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-300 active:cursor-grabbing active:scale-100 ${docked ? "animate-proof-breathe" : "shadow-[0_12px_32px_rgba(224,94,60,0.36)] hover:shadow-[0_16px_40px_rgba(224,94,60,0.48)]"}`}
            aria-label="Open Proof Intelligence; drag to move"
          >
            <span className="absolute inset-[-6px] -z-10 rounded-full bg-orange-400/20 blur-[5px] transition group-hover:bg-orange-400/30" />
            <span className="absolute inset-[4px] rounded-full border border-white/25 bg-white/10" />
            <Sparkles className="relative h-5 w-5 drop-shadow-sm" strokeWidth={2.25} />
            <span className="absolute right-0 top-0 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500 shadow-sm" />
            <span className={`pointer-events-none absolute top-1/2 hidden -translate-y-1/2 whitespace-nowrap rounded-full border border-orange-100 bg-white/95 px-3 py-1.5 text-[10px] font-bold text-slate-700 shadow-lg backdrop-blur-md group-hover:block ${isLeftHalf ? "left-[56px]" : "right-[56px]"}`}>
              {bookId ? "Proof Intelligence is live" : "Proof Intelligence"}
            </span>
          </button>
        ) : (
          <section
            className="relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-orange-200/80 bg-white/95 shadow-[0_28px_80px_rgba(61,39,29,0.22),0_8px_24px_rgba(224,94,60,0.12)] ring-1 ring-white backdrop-blur-xl"
            role="dialog"
            aria-label="Proof Intelligence"
            style={{
              width: "min(340px, calc(100vw - 24px))",
              height: "min(500px, calc(100vh - 24px))",
              minWidth: 280,
              minHeight: 340,
              maxWidth: "min(680px, calc(100vw - 24px))",
              maxHeight: "calc(100vh - 24px)",
              resize: "both",
            }}
          >
            <header data-agent-drag className="flex h-[68px] shrink-0 cursor-grab select-none items-center gap-3 border-b border-orange-100/80 bg-gradient-to-r from-orange-50 via-white to-white px-4 active:cursor-grabbing">
              <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-brand-600 text-white shadow-lg shadow-orange-500/25">
                <Sparkles className="h-5 w-5" />
                <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-[2.5px] border-white bg-emerald-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-bold tracking-tight text-slate-900">SAGE Model</p>
                <p className="text-[9.5px] leading-tight font-medium text-slate-500">{bookId ? <><span className="text-emerald-600">Live</span> · Strategic Analysis and Guided Explanation</> : <span className="text-orange-500">Strategic Analysis and Guided Explanation</span>}</p>
              </div>
              <GripHorizontal className="h-4 w-4 text-orange-300" />
              <button onPointerDown={(e) => e.stopPropagation()} onClick={closeAssistant} className="rounded-full border border-orange-100 bg-white p-2 text-slate-500 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-orange-300 hover:bg-orange-50 hover:text-brand-600" aria-label="Let companion rest"><ChevronDown className="h-4 w-4" /></button>
            </header>

            <div ref={scrollRef} role="log" aria-live="polite" aria-relevant="additions" className="custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain bg-gradient-to-b from-white to-orange-50/25 px-4 py-4">
              {bookId && (
                <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[10px] font-semibold transition-all duration-500 ${pageChanging ? "border-orange-300 bg-orange-50 text-brand-700 shadow-sm shadow-orange-500/10" : "border-orange-100 bg-white/80 text-slate-500"}`}>
                  <span className={`flex h-6 w-6 items-center justify-center rounded-full ${pageChanging ? "bg-orange-500 text-white" : "bg-orange-100 text-brand-600"}`}>{pageChanging ? <Loader2 className="h-3 w-3 animate-spin" /> : pageNumber}</span>
                  <span className="min-w-0 flex-1 truncate">{pageChanging ? `Loading page ${pageNumber} context…` : `Page ${pageNumber} active · text, issues and project memory ready`}</span>
                </div>
              )}
              {messages.length === 0 && (
                <div className="pt-2">
                  <div className="mb-4 flex items-start gap-3">
                    <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-100 text-brand-600"><Sparkles className="h-3.5 w-3.5" /></span>
                    <div>
                      <p className="text-[15px] font-black tracking-[-0.02em] text-slate-800">{bookId ? "I’m with you on this page." : "Ready when your project is."}</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{bookId ? "Point me to text, an issue, or a visual region. I’ll respond from the live project evidence—not from assumptions." : "Start or open a proofreading project and I’ll connect to its pages, issues, instructions and live session context."}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {["Explain this flag", "Check consistency", "What am I looking at?", "Remember a rule"].map((prompt) => (
                      <button key={prompt} disabled={!bookId} onClick={() => setInput(prompt)} className="rounded-xl border border-orange-100 bg-white px-3 py-2 text-left text-[10px] font-bold text-slate-600 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-orange-300 hover:bg-orange-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0">{prompt}</button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((message, index) => (
                <div key={`${index}-${message.role}`} className={`flex w-full flex-col ${message.role === "user" ? "items-end" : "items-start"}`}>
                  {message.role === "assistant" && (
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] bg-brand-50 text-brand-600 shadow-sm ring-1 ring-brand-200/50">
                        <Sparkles className="h-3.5 w-3.5" />
                      </span>
                      <span className="text-[11px] font-bold text-slate-800">SAGE Model</span>
                    </div>
                  )}
                  <div className={`break-words text-[12px] leading-relaxed ${message.role === "user" ? "max-w-[85%] rounded-2xl rounded-tr-[4px] bg-gradient-to-br from-orange-400 to-brand-600 px-3.5 py-2.5 text-white shadow-sm shadow-orange-500/15" : "w-full pl-8 text-slate-700"}`}>
                    {message.role === "user" ? message.content : <ResponseText content={message.content} />}
                  </div>
                  {(message.hasCapture || (message.pageNumber && message.role === "user")) && (
                    <div className={`mt-1.5 flex items-center gap-1.5 text-[9px] font-medium text-slate-400 ${message.role === "user" ? "pr-1" : "pl-8"}`}>
                      {message.pageNumber && message.role === "user" && <span>Page {message.pageNumber}</span>}
                      {message.hasCapture && message.pageNumber && message.role === "user" && <span>•</span>}
                      {message.hasCapture && <span>Live visual attached</span>}
                    </div>
                  )}
                </div>
              ))}
              {(historyLoading || busy) && <div className="rounded-2xl border border-orange-100 bg-white p-3 shadow-sm"><div className="flex items-center gap-2.5 text-[11px] font-semibold text-slate-600"><span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-orange-100 text-brand-600"><Loader2 className="h-4 w-4 animate-spin" /><span className="absolute inset-0 animate-ping rounded-full border border-orange-300/50" /></span>{busy ? PROCESS_STEPS[processingStep] : "Rejoining this conversation…"}</div>{busy && <div className="mt-2 flex gap-1 pl-10">{PROCESS_STEPS.map((_, index) => <span key={index} className={`h-1 flex-1 rounded-full transition-colors duration-500 ${index <= processingStep ? "bg-orange-400" : "bg-orange-100"}`} />)}</div>}</div>}
            </div>

            {(selectedText || captureDataUrl) && (
              <div className="px-3 pt-2 flex gap-2 bg-white">
                {selectedText && <span className="min-w-0 flex-1 truncate rounded-lg border border-orange-200 bg-orange-50 px-2 py-1 text-[10px] font-semibold text-orange-800" title={selectedText}>Selected: “{selectedText}”</span>}
                {captureDataUrl && <div className="relative h-12 w-16 overflow-hidden rounded-lg border border-brand-200"><Image src={captureDataUrl} alt="Captured PDF region" fill className="object-cover" /><button onClick={() => setCaptureDataUrl("")} className="absolute right-0 top-0 rounded-bl-md bg-brand-600/90 p-0.5 text-white transition hover:bg-brand-700"><X className="h-3 w-3" /></button></div>}
              </div>
            )}
            {error && <div className="mx-4 mt-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-[10px] font-medium text-red-600">{error}</div>}

            <div className="border-t border-slate-100 bg-slate-50/60 p-3">
              <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-[0_2px_12px_rgba(0,0,0,0.03)] transition-all focus-within:border-brand-300 focus-within:ring-4 focus-within:ring-brand-100/50">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
                  placeholder="Ask SAGE Model..."
                  rows={1}
                  maxLength={2400}
                  className="custom-scrollbar max-h-32 min-h-[44px] w-full resize-none bg-transparent px-3 py-2.5 text-xs text-slate-800 outline-none placeholder:text-slate-400"
                />
                <div className="flex w-full items-center justify-between px-1 pb-1">
                  <div className="flex h-8 flex-1 min-w-0 flex-wrap items-center gap-1 overflow-hidden">
                    <button disabled={!bookId} onPointerDown={(event) => event.preventDefault()} onClick={useCurrentSelection} className="flex shrink-0 h-8 items-center gap-1.5 rounded-xl px-2.5 text-[10px] font-bold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40" title="Use highlighted text">
                      <MousePointer2 className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Text</span>
                    </button>
                    <button disabled={!bookId} onClick={() => { setExpanded(false); setCaptureMode(true); setError(""); }} className="flex shrink-0 h-8 items-center gap-1.5 rounded-xl px-2.5 text-[10px] font-bold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40" title="Capture region">
                      <Camera className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Region</span>
                    </button>

                    <div className="flex shrink-0 items-center gap-1">
                      <div className="mx-1 h-4 w-px bg-slate-200"></div>
                      <button onClick={() => setIsDetailed(!isDetailed)} className={`flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-[10px] font-bold transition-colors ${isDetailed ? 'bg-brand-50 text-brand-700' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`} title="Toggle detailed response">
                        Detailed
                        <span className={`flex h-3.5 w-6 items-center rounded-full p-0.5 transition-colors ${isDetailed ? 'justify-end bg-brand-500' : 'justify-start bg-slate-300'}`}>
                          <span className="h-2.5 w-2.5 rounded-full bg-white shadow-sm" />
                        </span>
                      </button>
                    </div>
                    {(selectedText || captureDataUrl) && (
                      <button onClick={() => { setSelectedText(""); setCaptureDataUrl(""); }} className="ml-1 flex h-8 w-8 items-center justify-center rounded-xl text-red-400 transition-colors hover:bg-red-50 hover:text-red-600" title="Clear attachments">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <button disabled={busy || historyLoading || !input.trim() || !bookId} onClick={() => void send()} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white shadow-sm transition-all hover:scale-105 hover:bg-slate-800 disabled:scale-100 disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none">
                    <Send className="ml-0.5 h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <p className="mt-2.5 text-center text-[9px] font-semibold text-slate-400">SAGE Model AI • Mode: {isDetailed ? 'Comprehensive (8192)' : 'Concise (2048)'}</p>
            </div>
            <div className="pointer-events-none absolute bottom-1.5 right-1.5 h-3 w-3 border-b-2 border-r-2 border-orange-300/80" aria-hidden="true" />
          </section>
        )}
      </div>
    </>,
    document.body,
  );
}
