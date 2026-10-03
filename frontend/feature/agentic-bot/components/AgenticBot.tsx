"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Camera, ChevronDown, GripHorizontal, Loader2, MessageCircle, MousePointer2, Send, Trash2, X } from "lucide-react";

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

const COLLAPSED_WIDTH = 176;
const COLLAPSED_HEIGHT = 52;
const PANEL_WIDTH = 390;
const PANEL_HEIGHT = 590;
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
  const [error, setError] = useState("");
  const [position, setPosition] = useState<Point | null>(null);
  const dragRef = useRef<{ pointer: Point; origin: Point } | null>(null);
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
      return;
    }
    fetch(`/api/agentic-bot?bookId=${encodeURIComponent(bookId)}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not load assistant");
        setMessages(payload.messages || []);
      })
      .catch((reason) => setError(reason.message));
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
    dragRef.current = { pointer: { x: event.clientX, y: event.clientY }, origin };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onDragMove = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    setPosition(clampPosition({
      x: dragRef.current.origin.x + event.clientX - dragRef.current.pointer.x,
      y: dragRef.current.origin.y + event.clientY - dragRef.current.pointer.y,
    }, expanded));
  };
  const onDragEnd = () => {
    dragRef.current = null;
    setPosition((current) => current ? clampPosition(current, expanded) : null);
  };

  const openAssistant = () => {
    setPosition((current) => current ? clampPosition(current, true) : null);
    setExpanded(true);
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
          className="fixed inset-0 z-[100001] cursor-crosshair bg-slate-950/10"
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
        className={`fixed z-[100000] ${expanded ? "w-[390px] max-w-[calc(100vw-24px)]" : "w-[176px] max-w-[calc(100vw-24px)]"}`}
        style={position
          ? { left: position.x, top: position.y }
          : expanded
            ? { right: 20, bottom: 20 }
            : { right: 24, bottom: 76 }}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        {!expanded ? (
          <button
            data-agent-drag
            onDoubleClick={openAssistant}
            onClick={openAssistant}
            className="h-[52px] w-[176px] max-w-full rounded-2xl bg-white text-slate-800 shadow-2xl shadow-orange-500/25 border-2 border-brand-500 flex items-center gap-2.5 px-3 cursor-grab active:cursor-grabbing hover:-translate-y-0.5 hover:shadow-orange-500/35 transition-all ring-4 ring-white/80"
            title="Open project assistant (drag to move)"
          >
            <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-400 to-brand-600 text-white shadow-md shadow-orange-500/25">
              <MessageCircle className="h-5 w-5" />
              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />
            </span>
            <span className="min-w-0 text-left">
              <span className="block truncate text-xs font-black tracking-wide">Project assistant</span>
              <span className="block truncate text-[9px] font-semibold text-brand-600">Drag anywhere · Click to open</span>
            </span>
          </button>
        ) : (
          <section className="h-[590px] max-h-[calc(100vh-24px)] rounded-2xl bg-white border-2 border-brand-400 shadow-2xl shadow-orange-500/20 overflow-hidden flex flex-col ring-4 ring-white/80">
            <header data-agent-drag className="h-14 shrink-0 px-3.5 bg-gradient-to-r from-orange-500 to-brand-600 text-white flex items-center gap-2.5 cursor-grab active:cursor-grabbing select-none">
              <div className="h-8 w-8 rounded-xl bg-white/20 border border-white/25 flex items-center justify-center"><Bot className="h-4.5 w-4.5" /></div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-black tracking-wide">Project assistant</p>
                <p className="text-[10px] text-slate-300 truncate">{projectTitle || "Live proofread"} · Page {pageNumber}</p>
              </div>
              <GripHorizontal className="h-4 w-4 text-orange-100" />
              <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setExpanded(false)} className="p-1.5 hover:bg-white/10 rounded-lg" aria-label="Collapse assistant"><ChevronDown className="h-4 w-4" /></button>
            </header>

            <div ref={scrollRef} className="flex-1 overflow-y-auto p-3.5 space-y-3 bg-slate-50/70">
              {messages.length === 0 && (
                <div className="rounded-xl border border-brand-100 bg-brand-50/70 p-3 text-xs text-slate-600 leading-relaxed">
                  Ask about the current page or any live issue. Use <b>/remember</b> to add a confirmed project rule. You can also say “open page 4”, “pause analysis”, “resume analysis”, or “reanalyze page 4”.
                </div>
              )}
              {messages.map((message, index) => (
                <div key={`${index}-${message.role}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[88%] rounded-2xl px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap ${message.role === "user" ? "bg-brand-600 text-white rounded-br-md" : "bg-white border border-slate-200 text-slate-700 rounded-bl-md shadow-sm"}`}>
                    {message.content}
                    {message.hasCapture && <span className="block mt-1 text-[9px] opacity-70">Captured page region attached</span>}
                  </div>
                </div>
              ))}
              {busy && <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading live project context…</div>}
            </div>

            {(selectedText || captureDataUrl) && (
              <div className="px-3 pt-2 flex gap-2 bg-white">
                {selectedText && <span className="min-w-0 flex-1 truncate text-[10px] bg-amber-50 text-amber-800 border border-amber-200 rounded-lg px-2 py-1">Text: {selectedText}</span>}
                {captureDataUrl && <div className="relative h-12 w-16 rounded-lg overflow-hidden border border-brand-200"><img src={captureDataUrl} alt="Captured PDF region" className="h-full w-full object-cover" /><button onClick={() => setCaptureDataUrl("")} className="absolute top-0 right-0 bg-slate-900/70 text-white"><X className="h-3 w-3" /></button></div>}
              </div>
            )}
            {error && <div className="mx-3 mt-2 text-[10px] text-red-600 bg-red-50 border border-red-100 rounded-lg px-2 py-1.5">{error}</div>}

            <div className="p-3 bg-white border-t border-slate-200 space-y-2">
              <div className="flex items-center gap-1">
                <button onClick={useCurrentSelection} className="px-2 py-1 rounded-lg text-[10px] font-bold text-slate-600 hover:bg-slate-100 flex items-center gap-1"><MousePointer2 className="h-3 w-3" /> Use selected text</button>
                <button onClick={() => { setExpanded(false); setCaptureMode(true); setError(""); }} className="px-2 py-1 rounded-lg text-[10px] font-bold text-slate-600 hover:bg-slate-100 flex items-center gap-1"><Camera className="h-3 w-3" /> Capture page</button>
                {(selectedText || captureDataUrl) && <button onClick={() => { setSelectedText(""); setCaptureDataUrl(""); }} className="ml-auto p-1 text-slate-400 hover:text-red-500" title="Clear attachments"><Trash2 className="h-3 w-3" /></button>}
              </div>
              <div className="flex gap-2 items-end">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
                  placeholder="Ask about this page, issue, or project…"
                  rows={2}
                  maxLength={2400}
                  className="flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                />
                <button disabled={busy || !input.trim()} onClick={() => void send()} className="h-10 w-10 rounded-xl bg-brand-600 hover:bg-brand-700 disabled:bg-slate-200 text-white flex items-center justify-center"><Send className="h-4 w-4" /></button>
              </div>
            </div>
          </section>
        )}
      </div>
    </>,
    document.body,
  );
}
