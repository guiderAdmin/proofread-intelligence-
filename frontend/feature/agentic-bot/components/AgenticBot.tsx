"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, ChevronDown, GripHorizontal, Loader2, MousePointer2, Send, Sparkles, Trash2, X } from "lucide-react";

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
  onNavigatePage?: (pageNumber: number) => void;
}

type Point = { x: number; y: number };
type CaptureRect = { left: number; top: number; width: number; height: number };

const COLLAPSED_WIDTH = 68;
const COLLAPSED_HEIGHT = 68;
const PANEL_WIDTH = 374;
const PANEL_HEIGHT = 540;
function clampPosition(point: Point, expanded: boolean): Point {
  const width = expanded ? Math.min(PANEL_WIDTH, window.innerWidth - 24) : Math.min(COLLAPSED_WIDTH, window.innerWidth - 24);
  const height = expanded ? Math.min(PANEL_HEIGHT, window.innerHeight - 24) : COLLAPSED_HEIGHT;
  return {
    x: Math.max(12, Math.min(window.innerWidth - width - 12, point.x)),
    y: Math.max(12, Math.min(window.innerHeight - height - 12, point.y)),
  };
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
  const maxSide = 1400;
  const outputScale = Math.min(1, maxSide / Math.max(sw, sh));
  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.round(sw * outputScale));
  output.height = Math.max(1, Math.round(sh * outputScale));
  const context = output.getContext("2d");
  if (!context) return null;
  context.drawImage(best.canvas, sx, sy, sw, sh, 0, 0, output.width, output.height);
  return output.toDataURL("image/jpeg", 0.82);
}

export function AgenticBot({ bookId, pageNumber, stage, projectTitle, activeIssueUid, onNavigatePage }: AgenticBotProps) {
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState("");
  const [selectedText, setSelectedText] = useState("");
  const [captureDataUrl, setCaptureDataUrl] = useState("");
  const [captureMode, setCaptureMode] = useState(false);
  const [captureStart, setCaptureStart] = useState<Point | null>(null);
  const [captureCurrent, setCaptureCurrent] = useState<Point | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState("");
  const [position, setPosition] = useState<Point | null>(null);
  const dragRef = useRef<{ pointer: Point; origin: Point; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const loadedBookRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Start with CSS right/bottom anchoring. Persisted pixel coordinates are
    // deliberately not restored: browser zoom, sidebars and monitor changes
    // can otherwise leave a valid-looking coordinate outside the real view.
    setPosition(null);
    setMounted(true);
  }, []);

  // A collapsed launcher can legally sit near the right or bottom edge. When
  // its 390px panel opens, re-clamp synchronously so it can never expand
  // outside the visible browser area.
  useLayoutEffect(() => {
    if (!mounted || typeof window === "undefined") return;
    setPosition((current) => current ? clampPosition(current, expanded) : null);
  }, [expanded, mounted]);

  useEffect(() => {
    if (!bookId) {
      setMessages([]);
      loadedBookRef.current = null;
    }
  }, [bookId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  useEffect(() => {
    const onResize = () => setPosition((current) => {
      return current ? clampPosition(current, expanded) : null;
    });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [expanded]);

  if (!bookId || !mounted) return null;

  const onDragStart = (event: React.PointerEvent) => {
    if (!(event.target as HTMLElement).closest("[data-agent-drag]")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const origin = position || { x: bounds.left, y: bounds.top };
    setPosition(origin);
    dragRef.current = { pointer: { x: event.clientX, y: event.clientY }, origin, moved: false };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onDragMove = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.pointer.x;
    const dy = event.clientY - dragRef.current.pointer.y;
    if (!dragRef.current.moved && Math.hypot(dx, dy) < 3) return;
    dragRef.current.moved = true;
    setPosition(clampPosition({
      x: dragRef.current.origin.x + dx,
      y: dragRef.current.origin.y + dy,
    }, expanded));
  };
  const onDragEnd = () => {
    const moved = dragRef.current?.moved;
    dragRef.current = null;
    setPosition((current) => current ? clampPosition(current, expanded) : null);
    if (moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
  };

  const loadConversation = async () => {
    if (!bookId || loadedBookRef.current === bookId) return;
    loadedBookRef.current = bookId;
    setHistoryLoading(true);
    try {
      const response = await fetch(`/api/agentic-bot?bookId=${encodeURIComponent(bookId)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load companion");
      setMessages(payload.messages || []);
    } catch (reason: any) {
      loadedBookRef.current = null;
      setError(reason.message || "Could not load companion");
    } finally {
      setHistoryLoading(false);
    }
  };

  const openAssistant = () => {
    if (suppressClickRef.current) return;
    setPosition((current) => current ? clampPosition(current, true) : null);
    setExpanded(true);
    void loadConversation();
  };

  const useCurrentSelection = () => {
    const selection = window.getSelection();
    const text = String(selection || "").replace(/\s+/g, " ").trim().slice(0, 2400);
    if (!text) {
      setError("Select text on the PDF page first.");
      return;
    }
    const anchor = selection?.anchorNode?.parentElement;
    if (!anchor?.closest(".react-pdf__Page__textLayer")) {
      setError("The selection must come from the open PDF page.");
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
    if (!message || busy) return;
    const optimistic: AgentMessage = { role: "user", content: message, pageNumber, hasCapture: Boolean(captureDataUrl) };
    setMessages((current) => [...current, optimistic]);
    setInput("");
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/agentic-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, pageNumber, message, selectedText, captureDataUrl, activeIssueUid, stage }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Assistant request failed");
      setMessages((current) => [...current, { role: "assistant", content: payload.answer, pageNumber }]);
      if (payload.action?.kind === "navigate" && Number.isInteger(payload.action.pageNumber)) {
        onNavigatePage?.(payload.action.pageNumber);
      }
      setCaptureDataUrl("");
      setSelectedText("");
    } catch (reason: any) {
      setError(reason.message || "Assistant request failed");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <>
      {captureMode && (
        <div
          className="fixed inset-0 cursor-crosshair bg-slate-950/10"
          style={{ zIndex: 2147483647 }}
          onPointerDown={(event) => { setCaptureStart({ x: event.clientX, y: event.clientY }); setCaptureCurrent({ x: event.clientX, y: event.clientY }); }}
          onPointerMove={(event) => captureStart && setCaptureCurrent({ x: event.clientX, y: event.clientY })}
          onPointerUp={completeCapture}
          onKeyDown={(event) => event.key === "Escape" && setCaptureMode(false)}
          tabIndex={0}
          autoFocus
        >
          <div className="absolute top-5 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-xl">
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
        className={`fixed ${expanded ? "w-[374px] max-w-[calc(100vw-24px)]" : "h-[68px] w-[68px]"}`}
        style={position
          ? { left: position.x, top: position.y, zIndex: 2147483646, touchAction: "none" }
          : expanded
            ? { right: 20, bottom: 20, zIndex: 2147483646, touchAction: "none" }
            : { right: 24, bottom: 76, zIndex: 2147483646, touchAction: "none" }}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        {!expanded ? (
          <button
            data-agent-drag
            onClick={openAssistant}
            className="group relative flex h-[68px] w-[68px] cursor-grab items-center justify-center rounded-full border-[3px] border-white bg-gradient-to-br from-orange-400 via-brand-500 to-brand-700 text-white shadow-[0_16px_42px_rgba(224,94,60,0.42)] ring-1 ring-orange-300/70 transition-[transform,box-shadow] duration-300 hover:scale-105 hover:shadow-[0_20px_52px_rgba(224,94,60,0.52)] active:cursor-grabbing active:scale-100"
            title="Your proofing companion — drag freely or click to talk"
            aria-label="Open proofing companion; drag to move"
          >
            <span className="absolute inset-[-8px] -z-10 rounded-full bg-orange-400/20 blur-md transition group-hover:bg-orange-400/30" />
            <span className="absolute inset-[5px] rounded-full border border-white/25 bg-white/10" />
            <Sparkles className="relative h-7 w-7 drop-shadow-sm" strokeWidth={2.25} />
            <span className="absolute right-0.5 top-0.5 h-3.5 w-3.5 rounded-full border-[3px] border-white bg-emerald-500 shadow-sm" />
            <span className="pointer-events-none absolute right-[76px] top-1/2 hidden -translate-y-1/2 whitespace-nowrap rounded-full border border-orange-100 bg-white/95 px-3 py-1.5 text-[10px] font-bold text-slate-700 shadow-lg backdrop-blur-md group-hover:block">
              I&apos;m here when you need me
            </span>
          </button>
        ) : (
          <section className="flex h-[540px] max-h-[calc(100vh-24px)] flex-col overflow-hidden rounded-[28px] border border-orange-200/80 bg-white/95 shadow-[0_28px_80px_rgba(61,39,29,0.22),0_8px_24px_rgba(224,94,60,0.12)] ring-1 ring-white backdrop-blur-xl">
            <header data-agent-drag className="flex h-[68px] shrink-0 cursor-grab select-none items-center gap-3 border-b border-orange-100/80 bg-gradient-to-r from-orange-50 via-white to-white px-4 active:cursor-grabbing">
              <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-brand-600 text-white shadow-lg shadow-orange-500/25">
                <Sparkles className="h-5 w-5" />
                <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-[2.5px] border-white bg-emerald-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-black tracking-[-0.01em] text-slate-900">Your proofing companion</p>
                <p className="truncate text-[10px] font-medium text-slate-500">Here with you on page {pageNumber} · {projectTitle || "Live proofread"}</p>
              </div>
              <GripHorizontal className="h-4 w-4 text-orange-300" />
              <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setExpanded(false)} className="rounded-full border border-orange-100 bg-white p-2 text-slate-500 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-brand-600" aria-label="Let companion rest"><ChevronDown className="h-4 w-4" /></button>
            </header>

            <div ref={scrollRef} className="custom-scrollbar flex-1 space-y-4 overflow-y-auto bg-gradient-to-b from-white to-orange-50/25 px-4 py-4">
              {messages.length === 0 && (
                <div className="pt-2">
                  <div className="mb-4 flex items-start gap-3">
                    <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-100 text-brand-600"><Sparkles className="h-3.5 w-3.5" /></span>
                    <div>
                      <p className="text-[15px] font-black tracking-[-0.02em] text-slate-900">What would you like to understand?</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">I can look at this page, the active issue, selected text, or a captured region—only when you ask.</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {["Explain this flag", "Check consistency", "What am I looking at?", "Remember a rule"].map((prompt) => (
                      <button key={prompt} onClick={() => setInput(prompt)} className="rounded-xl border border-orange-100 bg-white px-3 py-2 text-left text-[10px] font-bold text-slate-600 shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-brand-700">{prompt}</button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((message, index) => (
                <div key={`${index}-${message.role}`} className={`flex items-start gap-2.5 ${message.role === "user" ? "flex-row-reverse" : ""}`}>
                  <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-black ${message.role === "user" ? "bg-slate-900 text-white" : "bg-orange-100 text-brand-600"}`}>
                    {message.role === "user" ? "You".slice(0, 1) : <Sparkles className="h-3.5 w-3.5" />}
                  </span>
                  <div className={`max-w-[84%] text-[12px] leading-relaxed whitespace-pre-wrap ${message.role === "user" ? "rounded-2xl rounded-tr-md bg-slate-900 px-3.5 py-2.5 text-white" : "pt-1 text-slate-700"}`}>
                    {message.content}
                    {message.hasCapture && <span className="mt-1 block text-[9px] opacity-60">Page region shared</span>}
                  </div>
                </div>
              ))}
              {(historyLoading || busy) && <div className="flex items-center gap-2.5 text-[11px] font-medium text-slate-500"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-100 text-brand-600"><Loader2 className="h-3.5 w-3.5 animate-spin" /></span>{busy ? "Looking at your live project…" : "Rejoining this conversation…"}</div>}
            </div>

            {(selectedText || captureDataUrl) && (
              <div className="px-3 pt-2 flex gap-2 bg-white">
                {selectedText && <span className="min-w-0 flex-1 truncate text-[10px] bg-amber-50 text-amber-800 border border-amber-200 rounded-lg px-2 py-1">Text: {selectedText}</span>}
                {captureDataUrl && <div className="relative h-12 w-16 rounded-lg overflow-hidden border border-brand-200"><img src={captureDataUrl} alt="Captured PDF region" className="h-full w-full object-cover" /><button onClick={() => setCaptureDataUrl("")} className="absolute top-0 right-0 bg-slate-900/70 text-white"><X className="h-3 w-3" /></button></div>}
              </div>
            )}
            {error && <div className="mx-4 mt-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-[10px] font-medium text-red-600">{error}</div>}

            <div className="space-y-2.5 border-t border-orange-100/80 bg-white p-3.5">
              <div className="flex items-center gap-1.5">
                <button onClick={useCurrentSelection} className="flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1.5 text-[9px] font-bold text-slate-600 transition hover:border-orange-200 hover:bg-orange-50"><MousePointer2 className="h-3 w-3" /> Selected text</button>
                <button onClick={() => { setExpanded(false); setCaptureMode(true); setError(""); }} className="flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1.5 text-[9px] font-bold text-slate-600 transition hover:border-orange-200 hover:bg-orange-50"><Camera className="h-3 w-3" /> Show a region</button>
                {(selectedText || captureDataUrl) && <button onClick={() => { setSelectedText(""); setCaptureDataUrl(""); }} className="ml-auto p-1 text-slate-400 hover:text-red-500" title="Clear attachments"><Trash2 className="h-3 w-3" /></button>}
              </div>
              <div className="flex items-end gap-2 rounded-[20px] border border-slate-200 bg-slate-50/80 p-1.5 pl-3 shadow-inner transition focus-within:border-orange-300 focus-within:bg-white focus-within:ring-4 focus-within:ring-orange-100/60">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
                  placeholder="Tell me what you want to understand…"
                  rows={1}
                  maxLength={2400}
                  className="max-h-24 min-h-[38px] flex-1 resize-none bg-transparent py-2 text-xs text-slate-800 outline-none placeholder:text-slate-400"
                />
                <button disabled={busy || !input.trim()} onClick={() => void send()} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-brand-600 text-white shadow-md shadow-orange-500/20 transition hover:scale-105 disabled:scale-100 disabled:bg-none disabled:bg-slate-200 disabled:shadow-none"><Send className="h-4 w-4" /></button>
              </div>
              <p className="text-center text-[8px] font-medium tracking-wide text-slate-400">No AI request is made until you open or ask</p>
            </div>
          </section>
        )}
      </div>
    </>,
    document.body,
  );
}
