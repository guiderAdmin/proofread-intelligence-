"use client";

import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { 
  CheckSquare, ArrowRight, UploadCloud, RefreshCw, BarChart3, Edit3, Download, 
  Sparkles, AlertCircle, X, FileText,
  Cpu, Check, Database, ShieldAlert
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { UploadStage } from "./stages/UploadStage";
import { AnalysisStage } from "./stages/AnalysisStage";
import { DashboardStage } from "./stages/DashboardStage";
import dynamic from "next/dynamic";

const ReviewStage = dynamic(
  () => import("./stages/ReviewStage").then((mod) => mod.ReviewStage),
  { ssr: false }
);

import { ExportStage } from "./stages/ExportStage";
import { SettingsView } from "./system/SettingsView";
import { ChapterMemoryEditor } from "./feature/ChapterMemoryEditor";

const AppSidebar = dynamic(
  () => import("./system/AppSidebar").then((mod) => mod.AppSidebar),
  { ssr: false }
);

import { ProofreaderResponse, ProofreaderIssue, CustomMark, ProofreaderPageData } from "@/types/proofreader";
import { locateIssuesInPdf } from "@/lib/pdf-text-locator";
import { applyIssueGeometry, createSerialWriter, mergeIssueReviews } from "@/lib/review-state";
import { AgenticBot } from "../../feature/agentic-bot";

interface SavedBook {
  id: string;
  title: string;
  originalName?: string;
  pageCount: number;
  status: "queued" | "context_approval" | "processing" | "paused" | "done" | "error";
  progress?: { done?: number; failed?: number };
  stats?: { issues?: number };
  createdAt?: string;
}

async function persistMarksSnapshot({ jobId, marks }: { jobId: string; marks: CustomMark[] }) {
  const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/books/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customMarks: marks }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error || "Could not save manual marks");
  }
}

function readSession(key: string) {
  try { return typeof window === "undefined" ? null : window.sessionStorage.getItem(key); }
  catch { return null; }
}

function storeSession(key: string, value: string | null) {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch { /* Browsers may disable session storage; durable server state still works. */ }
}



export default function ProofreaderFlow() {
  const [isClient, setIsClient] = useState(false);
  useEffect(() => setIsClient(true), []);

  const [stage, setStage] = useState<"upload" | "analysis" | "dashboard" | "review" | "export">(() => {
    const saved = readSession("pf_stage");
    return ["upload", "analysis", "dashboard", "review", "export"].includes(saved || "") ? saved as "upload" | "analysis" | "dashboard" | "review" | "export" : "upload";
  });
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(true);
  const [sidebarActiveTab, setSidebarActiveTab] = useState<"proofreading" | "preview" | "settings">("proofreading");
  
  const [activePdfFilename, setActivePdfFilename] = useState<string | null>(null);
  const uploadPartsRef = useRef(1);

  // Polling is backed by durable MongoDB state; UI correctness does not depend
  // on an in-memory realtime channel staying connected.
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollInFlightRef = useRef(false);
  // Consecutive failed polls; polling only gives up after several in a row so a
  // brief network blip / dev-server reload does not kill live updates.
  const pollFailuresRef = useRef(0);
  // Stable backend uid -> numeric id so the active issue survives re-polls.
  const issueIdMapRef = useRef<Map<string, number>>(new Map());
  const marksLoadedRef = useRef(false);

  // Debounced marks-save refs – keeps the save serialised so rapid mark
  // additions never race against each other on the network.
  const marksSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingMarksSaveRef = useRef<{ jobId: string; marks: CustomMark[] } | null>(null);
  const failedMarksSaveRef = useRef<{ jobId: string; marks: CustomMark[] } | null>(null);
  const writeMarksRef = useRef(createSerialWriter(persistMarksSnapshot));
  const marksWriteRef = useRef<Promise<void>>(Promise.resolve());
  const activeJobIdRef = useRef<string | null>(null);
  const viewVersionRef = useRef(0);
  const pendingStatusRef = useRef(new Map<string, "open" | "accepted" | "dismissed">());
  const reviewVersionRef = useRef(0);
  // Set to true immediately before loading marks from DB; the save effect
  // consumes it once so we never write DB data straight back to MongoDB.
  const skipNextSaveRef = useRef(false);

  const [savedBooks, setSavedBooks] = useState<SavedBook[]>([]);
  const [savedBooksLoading, setSavedBooksLoading] = useState(true);
  const [isRefiningIssues, setIsRefiningIssues] = useState(false);

  const [selectedFile, setSelectedFile] = useState<{
    name: string;
    subject: string;
    size: string;
    pages: number;
    eta: string;
    rawFile?: File;
  } | null>(null);

  // Stable ref so async closures always read the current selectedFile
  const selectedFileRef = useRef(selectedFile);
  useEffect(() => { selectedFileRef.current = selectedFile; }, [selectedFile]);

  const [activeJobId, setActiveJobId] = useState<string | null>(() => {
    return readSession("pf_jobId");
  });
  const [analysisStatus, setAnalysisStatus] = useState<"queued" | "context_approval" | "processing" | "paused" | "done" | "error">("queued");
  const [uploadPhase, setUploadPhase] = useState<{ active: boolean; percent: number }>({ active: false, percent: 0 });
  const [progress, setProgress] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [completedPages, setCompletedPages] = useState(0);
  const [indexedPages, setIndexedPages] = useState(0);

  const [responseData, setResponseData] = useState<ProofreaderResponse | null>(null);
  const [issues, setIssues] = useState<ProofreaderIssue[]>([]);
  const latestIssuesRef = useRef(issues);
  latestIssuesRef.current = issues;
  const [isMemoryEditorOpen, setIsMemoryEditorOpen] = useState(false);
  const prevStatusRef = useRef(analysisStatus);
  
  useEffect(() => {
    if (analysisStatus === "context_approval" && prevStatusRef.current !== "context_approval") {
      setIsMemoryEditorOpen(true);
    }
    prevStatusRef.current = analysisStatus;
  }, [analysisStatus]);
  
  const [pages, setPages] = useState<ProofreaderPageData[]>([]);
  const [customMarks, setCustomMarks] = useState<CustomMark[]>([]);
  const [currentPage, setCurrentPage] = useState<number>(() => {
    const saved = Number(readSession("pf_page"));
    return Number.isSafeInteger(saved) && saved > 0 ? saved : 1;
  });
  const [activeIssueId, setActiveIssueId] = useState<number | null>(() => {
    const saved = Number(readSession("pf_issueId"));
    return Number.isSafeInteger(saved) && saved > 0 ? saved : null;
  });
  const [activeScanTypes, setActiveScanTypes] = useState<string[]>(["grammar", "object", "fact"]);
  const [showTerminateConfirm, setShowTerminateConfirm] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  useEffect(() => {
    const viewVersion = viewVersionRef;
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      viewVersion.current++;
    };
  }, []);

  // The function remains alive until one worker request completes. Status GETs stay read-only.
  const workerRequestRef=useRef<Promise<void>|null>(null);
  useEffect(()=>{
    if(!activeJobId || !["queued","processing"].includes(analysisStatus))return;
    let cancelled=false,timer:ReturnType<typeof setTimeout>;
    const work=async()=>{
      if(cancelled)return;
      if(workerRequestRef.current) {timer=setTimeout(work,2000);return;}
      const request=(async()=>{
        try {
          const response=await fetch((process.env.NEXT_PUBLIC_BASE_PATH || "") + "/api/worker",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({bookId:activeJobId})});
          if(!response.ok && !cancelled) {
            const payload=await response.json().catch(()=>({}));setGlobalError(payload.error||"Analysis worker is temporarily unavailable; saved findings are preserved.");
          }
        }catch(error:any){if(!cancelled)setGlobalError(error.message||"Analysis worker could not be reached.");}
      })();
      workerRequestRef.current=request;
      try{await request;}finally{if(workerRequestRef.current===request)workerRequestRef.current=null;}
      if(!cancelled)timer=setTimeout(work,2000);
    };
    void work();
    return ()=>{cancelled=true;clearTimeout(timer);};
  },[activeJobId,analysisStatus]);

  // ── Live bbox grounding ────────────────────────────────────────────────
  // Each poll returns raw backend issues (AI boxes). We cache the PDF-grounded
  // boxes per issue so re-polls never wipe them, and only locate NEW issues.
  const refinedBboxRef = useRef<Map<string, { bbox: any; bboxSource: any }>>(new Map());
  const refineRunningRef = useRef(false);
  const refineDirtyRef = useRef(false);

  const issueKey = (i: any) => `${i.backendUid ?? i.id}|${i.page ?? i.pageIndex ?? ""}|${i.originalText ?? ""}|${i.lastDetectedAt ?? ""}|${i.textStart ?? ""}`;

  const mergeRefined = (list: ProofreaderIssue[]): ProofreaderIssue[] =>
    list.map((i) => {
      const r = refinedBboxRef.current.get(issueKey(i));
      if (i.bbox && ["pdf_text", "ocr_text"].includes(i.bboxSource || "")) {
        refinedBboxRef.current.set(issueKey(i), { bbox: i.bbox, bboxSource: i.bboxSource }); return i;
      }
      return r?.bbox ? ({ ...i, bbox: r.bbox, bboxSource: r.bboxSource } as ProofreaderIssue) : i;
    });

  /** Ground any not-yet-located issues against the PDF text layer (serialised). */
  const refineIssues = async (list: ProofreaderIssue[], fileOverride?: File | null) => {
    const rawFile = fileOverride ?? selectedFileRef.current?.rawFile;
    if (!rawFile) return;
    if (refineRunningRef.current) { refineDirtyRef.current = true; return; }
    const pending = list.filter((i) => !refinedBboxRef.current.has(issueKey(i)) && !["ocr_text", "pdf_text"].includes(i.bboxSource || ""));
    if (!pending.length) return;
    refineRunningRef.current = true;
    const version = viewVersionRef.current;
    try {
      const refined = await locateIssuesInPdf(rawFile, pending);
      if (version !== viewVersionRef.current) return;
      refined.forEach((r: any) => {
        refinedBboxRef.current.set(issueKey(r), { bbox: r.bbox, bboxSource: r.bboxSource });
      });
      setIssues((prev) => applyIssueGeometry(prev, refined as ProofreaderIssue[]));
    } catch (err) {
      console.error("[live-refine] failed", err);
    } finally {
      refineRunningRef.current = false;
      if (refineDirtyRef.current) {
        refineDirtyRef.current = false;
        void refineIssues(latestIssuesRef.current, rawFile);
      }
    }
  };

  /** Push freshly polled issues to the UI instantly, keeping grounded boxes. */
  const applyLiveIssues = (list: ProofreaderIssue[], fetchedReviewVersion?: number) => {
    setIssues((current) => mergeRefined(mergeLiveIssues(list, current, fetchedReviewVersion)));
    void refineIssues(list);
  };

  // When the PDF blob becomes available (e.g. after reopening a book), ground
  // everything that is already on screen.
  useEffect(() => {
    if (selectedFile?.rawFile && latestIssuesRef.current.length) {
      void refineIssues(latestIssuesRef.current, selectedFile.rawFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile?.rawFile]);





  const stageOrder = ["upload", "analysis", "dashboard", "review", "export"];
  const prevStageRef = useRef(stage);

  useEffect(() => {
    prevStageRef.current = stage;
  }, [stage]);

  useEffect(() => {
    storeSession("pf_jobId", activeJobId);
  }, [activeJobId]);

  useEffect(() => {
    storeSession("pf_stage", stage);
  }, [stage]);

  useEffect(() => {
    storeSession("pf_page", currentPage.toString());
  }, [currentPage]);

  useEffect(() => {
    storeSession("pf_issueId", activeIssueId?.toString() || null);
  }, [activeIssueId]);

  // Keep stable refs so async callbacks always read current values
  useEffect(() => { activeJobIdRef.current = activeJobId; }, [activeJobId]);

  const saveMarks = (snapshot: { jobId: string; marks: CustomMark[] }) => {
    const request = writeMarksRef.current(snapshot);
    marksWriteRef.current = request;
    void request.then(() => {
      if (failedMarksSaveRef.current?.jobId === snapshot.jobId) failedMarksSaveRef.current = null;
    }, () => { failedMarksSaveRef.current = snapshot; });
    return request;
  };

  /** Flush any pending debounced save immediately (call before reloading DB data) */
  const flushMarksSave = async () => {
    if (marksSaveTimerRef.current) {
      clearTimeout(marksSaveTimerRef.current);
      marksSaveTimerRef.current = null;
    }
    const snapshot = pendingMarksSaveRef.current || failedMarksSaveRef.current;
    pendingMarksSaveRef.current = null;
    if (snapshot) saveMarks(snapshot);
    await marksWriteRef.current;
  };

  /**
   * Write a still-pending debounced marks save right now instead of dropping
   * it. keepalive lets the request finish even if the page is unloading.
   */
  const savePendingMarksNow = () => {
    if (!marksSaveTimerRef.current) return;
    clearTimeout(marksSaveTimerRef.current);
    marksSaveTimerRef.current = null;
    const snapshot = pendingMarksSaveRef.current || failedMarksSaveRef.current;
    if (!snapshot) return;
    const jobId = snapshot.jobId;
    const body = JSON.stringify({ customMarks: snapshot.marks });
    fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/books/${encodeURIComponent(jobId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
      // Browsers cap keepalive bodies at 64KB; larger payloads use a normal request.
      keepalive: body.length < 60_000,
    }).catch(() => {});
  };

  // Refresh / tab close: don't lose marks edited in the last debounce window.
  useEffect(() => {
    const onPageHide = () => savePendingMarksNow();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist custom marks to DB whenever they change – debounced 400 ms so
  // rapid additions/deletions collapse into a single PATCH request, preventing
  // out-of-order writes from clobbering the latest marks array.
  // Skips exactly one render after a DB load to avoid writing DB data back.
  useEffect(() => {
    if (!activeJobId || !isClient) return;
    if (!marksLoadedRef.current) return;

    // Consume the one-shot skip flag set by DB loads
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    // Cancel any previously scheduled save
    if (marksSaveTimerRef.current) clearTimeout(marksSaveTimerRef.current);

    // Capture the book and immutable array now, never from a later session.
    pendingMarksSaveRef.current = { jobId: activeJobId, marks: customMarks };
    marksSaveTimerRef.current = setTimeout(() => {
      marksSaveTimerRef.current = null;
      const snapshot = pendingMarksSaveRef.current;
      pendingMarksSaveRef.current = null;
      if (!snapshot) return;
      const request = saveMarks(snapshot);
      void request.catch((error) => setGlobalError(error.message || "Could not save manual marks"));
    }, 400);

    return () => {
      // Cleanup: cancel on unmount or before next effect run
      if (marksSaveTimerRef.current) {
        clearTimeout(marksSaveTimerRef.current);
        marksSaveTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customMarks, activeJobId, isClient]);

  const handleFileSelect = (file: File) => {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1) + " MB";
    setSelectedFile({
      name: file.name,
      subject: "Auto-detected by AI",
      size: sizeMB,
      pages: 0,
      eta: "30s",
      rawFile: file,
    });
  };

  const refreshSavedBooks = async () => {
    try {
      const response = await fetch((process.env.NEXT_PUBLIC_BASE_PATH || "") + "/api/books", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Could not load saved proofreads");
      setSavedBooks(Array.isArray(payload) ? payload : []);
    } catch (error: any) {
      setGlobalError(error.message || "Could not load saved proofreads");
    } finally {
      setSavedBooksLoading(false);
    }
  };

  useEffect(() => {
    void refreshSavedBooks();
  }, []);

  const [hasRestoredSession, setHasRestoredSession] = useState(false);

  useEffect(() => {
    if (savedBooks.length > 0 && activeJobId && !hasRestoredSession) {
      const book = savedBooks.find((b) => b.id === activeJobId);
      if (book) {
        setHasRestoredSession(true);
        void openSavedBook(book, true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedBooks, activeJobId, hasRestoredSession]);

  // Normalize persisted backend issue objects into the review UI shape.
  const normalizeIssue = (issue: any, idx: number) => {
    const pageNum =
      issue.page ??             // canonical (1-indexed, may be null)
      issue.page_number ??      // accepted legacy snake_case
      issue.pageNumber ??       // camelCase variant
      issue.pageIndex ??        // pageIndex fallback
      null;
    const pageIdx =
      issue.pageIndex ??
      issue.page_number ??
      issue.page ??
      null;

    const rawSeverity = issue.severity === "major" ? "high" : issue.severity === "minor" ? "low" : issue.severity;
    const severity: ProofreaderIssue["severity"] = ["critical", "high", "medium", "low"].includes(rawSeverity)
      ? rawSeverity
      : "medium";
    const box = issue.box;
    const boxSource = issue.bboxSource ?? issue.boxSource;
    const validBox = box && [box.xmin, box.ymin, box.xmax, box.ymax].every(Number.isFinite) &&
      box.xmin >= 0 && box.ymin >= 0 && box.xmax <= 1000 && box.ymax <= 1000 && box.xmax > box.xmin && box.ymax > box.ymin;
    const bbox = boxSource === "unverified" ? undefined : validBox ? {
      x: box.xmin / 10, y: box.ymin / 10,
      w: (box.xmax - box.xmin) / 10, h: (box.ymax - box.ymin) / 10,
    } : issue.bbox;
    const categories: Record<string, string> = {
      spelling: "Grammar", grammar: "Grammar", punctuation: "Grammar", wording: "Grammar", flow: "Grammar",
      chapter_alignment: "Structure", unit_alignment: "Structure", heading: "Structure", learning_outcomes: "Pedagogy",
      number: "Accuracy", page_number: "Accuracy", factual: "Accuracy", examples: "Accuracy",
      image: "Formatting", alignment: "Formatting", layout: "Formatting", spacing: "Formatting", overflow: "Formatting",
    };

    const stableKey = issue.uid ? String(issue.uid) : null;
    let stableId = idx + 1;
    if (stableKey) {
      const map = issueIdMapRef.current;
      let existing = map.get(stableKey);
      if (existing === undefined) {
        existing = map.size + 1;
        map.set(stableKey, existing);
      }
      stableId = existing;
    }

    return {
      ...issue,
      id: stableId,
      backendUid: issue.uid,
      page: typeof pageNum === "number" ? pageNum : null,
      pageIndex: typeof pageIdx === "number" ? pageIdx : null,
      originalText: issue.originalText ?? issue.text ?? issue.original_text ?? issue.quote ?? "",
      suggestedText: issue.suggestedText ?? issue.suggested_text ?? issue.suggestion ?? "",
      explanation: issue.explanation ?? issue.reason ?? issue.why ?? "",
      category: issue.category ?? issue.issueCategory ?? categories[issue.type] ?? "Style",
      type: issue.type ?? issue.issueType ?? issue.subtype ?? "Issue",
      severity,
      locationHint: issue.locationHint ?? issue.location ?? (pageNum ? `Page ${pageNum}` : ""),
      confidence: issue.confidence ?? 1.0,
      bbox,
      bboxSource: boxSource,
      resolved: issue.status === "accepted" || issue.status === "fixed" || !!issue.resolved,
      ignored: issue.status === "dismissed" || !!issue.ignored,
    };
  };

  const buildResponse = (book: any, backendPages: any[]): ProofreaderResponse => {
    const normalized = backendPages.flatMap((page: any) =>
      (page.issues || []).map((issue: any) => ({ ...issue, page: page.pageNumber, pageIndex: page.pageNumber }))
    ).map(normalizeIssue);
    const severityCounts = normalized.reduce((counts, issue) => {
      counts[issue.severity as keyof typeof counts] += 1;
      return counts;
    }, { critical: 0, high: 0, medium: 0, low: 0 });
    const reviewed = backendPages.filter((page: any) => page.status === "done").length;
    const failed = backendPages.filter((page: any) => page.status === "error").length;
    return {
      success: book.status === "done" && failed === 0,
      pagesReviewed: reviewed,
      pagesExpected: book.pageCount,
      visualReviewPendingCount: backendPages.filter((page: any) => page.status !== "done" || page.analysisWarnings?.length).length,
      issueCount: normalized.length,
      printReady: book.status === "done" && failed === 0 && normalized.length === 0 && backendPages.every((page: any) => !page.analysisWarnings?.length && page.coverage?.complete === true),
      severityCounts,
      issues: normalized,
      perPage: backendPages,
      model: book.analysisModel || "gemini-3.6-flash",
    };
  };

  const mergeLiveIssues = (incoming: ProofreaderIssue[], current: ProofreaderIssue[], fetchedReviewVersion?: number) =>
    mergeIssueReviews(incoming, current, pendingStatusRef.current,
      fetchedReviewVersion !== undefined && fetchedReviewVersion < reviewVersionRef.current);
  /** Poll a running/resumed job and stream its issues to the canvas live. */
  const startLivePolling = (saved: SavedBook, isRestore = true) => {
    const version = viewVersionRef.current;
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollFailuresRef.current = 0;
    pollInFlightRef.current = false;
    pollIntervalRef.current = setInterval(async () => {
      if (pollInFlightRef.current || version !== viewVersionRef.current) return;
      pollInFlightRef.current = true;
      try {
        const fetchedReviewVersion = reviewVersionRef.current;
        const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/job?id=${encodeURIComponent(saved.id)}`, { cache: "no-store" });
        let live: any = {};
        try {
          live = await response.json();
        } catch (e) {
          throw new Error(`Server returned an invalid response (HTTP ${response.status})`);
        }
        if (version !== viewVersionRef.current) return;
        if (!response.ok) throw new Error(live?.error || "Could not refresh analysis");
        if (!live?.book) throw new Error("Server returned no book data");
        pollFailuresRef.current = 0;
        const done = Number(live.book.progress?.done || 0);
        const failed = Number(live.book.progress?.failed || 0);
        const backendPages = live.pages || [];
        const expected = Number(live.book.pageCount || backendPages.length || 0);

        setAnalysisStatus(live.book.status);
        setCompletedPages(done);
        setIndexedPages(Number(live.book.progress?.indexed || 0));
        setTotalPages(expected);
        setProgress(expected ? Math.min(100, Math.round(((done + failed) / expected) * 100)) : 0);

        if (done > 0 && live.book.status !== "done") {
          setPages(backendPages.map((page: any) => ({
            page_number: page.pageNumber,
            image_url: page.imageUrl,
          })));
          const liveData = buildResponse(live.book, backendPages);
          setResponseData(liveData);
          applyLiveIssues(liveData.issues, fetchedReviewVersion);
          if (!marksLoadedRef.current) {
            marksLoadedRef.current = true;
            setCustomMarks(live.book.customMarks || []);
          }
        }

        if (["done", "error", "paused"].includes(live.book.status)) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          await refreshSavedBooks();
          if (version !== viewVersionRef.current) return;
          if (live.book.status === "done") await openSavedBook({ ...saved, status: "done" }, isRestore);
          else setGlobalError(live.book.error || (live.book.status === "paused" ? "Analysis paused" : "Analysis failed"));
        }
      } catch (error: any) {
        if (version !== viewVersionRef.current) return;
        pollFailuresRef.current += 1;
        if (pollFailuresRef.current >= 5) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setGlobalError(error.message || "Could not refresh analysis");
        }
      } finally {
        pollInFlightRef.current = false;
      }
    }, 2000);
  };

  const openSavedBook = async (saved: SavedBook, isRestore = false) => {
    const version = ++viewVersionRef.current;
    const sameBook = activeJobIdRef.current === saved.id;
    const marksAlreadyLoaded = sameBook && marksLoadedRef.current;
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    try {
      setGlobalError(null);
      if (saved.id !== activeJobIdRef.current) refinedBboxRef.current.clear();
      await flushMarksSave();
      if (version !== viewVersionRef.current) return;
      const fetchedReviewVersion = reviewVersionRef.current;
      const jobResponse = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/books/${encodeURIComponent(saved.id)}`, { cache: "no-store" });
      const payload = await jobResponse.json();
      if (version !== viewVersionRef.current) return;
      if (!jobResponse.ok) throw new Error(payload?.error || "Could not open this proofread");
      // The reader may add a mark while the GET is in flight. Save it before
      // switching books; a same-book refresh keeps its newer local marks.
      await flushMarksSave();
      if (version !== viewVersionRef.current) return;

      const backendPages = Array.isArray(payload.pages) ? payload.pages : [];
      const data = buildResponse(payload.book, backendPages);
      activeJobIdRef.current = saved.id;
      setActiveJobId(saved.id);
      setAnalysisStatus(payload.book.status);
      const cachedFile = sameBook ? selectedFileRef.current?.rawFile : undefined;
      if (!cachedFile) setSelectedFile({
        name: saved.originalName || `${saved.title}.pdf`, subject: saved.title,
        size: "Loading...", pages: saved.pageCount, eta: "0s",
      });
      setTotalPages(saved.pageCount);
      setCompletedPages(payload.book.progress?.done || 0);
      setIndexedPages(Number(payload.book.progress?.indexed || 0));
      setProgress(saved.pageCount ? Math.round((((payload.book.progress?.done || 0) + (payload.book.progress?.failed || 0)) / saved.pageCount) * 100) : 0);
      setPages(backendPages.map((page: any) => ({ page_number: page.pageNumber, image_url: page.imageUrl })));
      setResponseData(data);
      const restoredIssues = mergeLiveIssues(data.issues, sameBook ? latestIssuesRef.current : [], fetchedReviewVersion);
      setIssues(mergeRefined(restoredIssues));
      setCurrentPage((page) => isRestore ? Math.max(1, Math.min(saved.pageCount, page)) : 1);

      // Only apply geometry to still-current issues. A slow file fetch from an
      // earlier book/reanalysis must not replace findings or review decisions.
      if (cachedFile) {
        void refineIssues(restoredIssues, cachedFile);
      } else {
      setIsRefiningIssues(true);
      void (async () => {
        try {
          const fileResponse = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/books/${encodeURIComponent(saved.id)}/file`, { cache: "no-store" });
          if (!fileResponse.ok) throw new Error("Could not load the PDF for review");
          const blob = await fileResponse.blob();
          if (version !== viewVersionRef.current) return;
          const rawFile = new File([blob], saved.originalName || `${saved.title}.pdf`, { type: "application/pdf" });
          setSelectedFile((current) => current ? { ...current, size: `${(blob.size / 1024 / 1024).toFixed(1)} MB`, rawFile } : null);
          const located = await locateIssuesInPdf(rawFile, data.issues);
          if (version === viewVersionRef.current) setIssues((current) => applyIssueGeometry(current, located as ProofreaderIssue[]));
        } catch (error: any) {
          if (version === viewVersionRef.current) setGlobalError(error.message || "Could not load PDF geometry");
        } finally {
          if (version === viewVersionRef.current) setIsRefiningIssues(false);
        }
      })();
      }

      if (!marksAlreadyLoaded) {
        skipNextSaveRef.current = true;
        marksLoadedRef.current = true;
        setCustomMarks(Array.isArray(payload.book.customMarks) ? payload.book.customMarks : []);
      }
      if (!isRestore) {
        setActiveIssueId(restoredIssues[0]?.id || null);
        setStage(payload.book.status === "done" ? "dashboard" : "analysis");
      }
      setSidebarActiveTab("proofreading");
      if (payload.book.status === "error" || payload.book.status === "paused") {
        setGlobalError(payload.book.error || "Analysis is paused. Resume it when the provider is available.");
      }
      if (["queued", "processing"].includes(payload.book.status)) {
        startLivePolling(saved, isRestore);
      }
    } catch (error: any) {
      if (version === viewVersionRef.current) setGlobalError(error.message || "Could not reopen this proofread");
    }
  };

  const deleteSavedBook = async (bookId: string) => {
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/books/${encodeURIComponent(bookId)}`, { method: "DELETE" });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.error || "Could not delete this proofread");
      }
      if (activeJobId === bookId) {
        viewVersionRef.current++;
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        activeJobIdRef.current = null;
        marksLoadedRef.current = false;
        pendingMarksSaveRef.current = null;
        failedMarksSaveRef.current = null;
        marksWriteRef.current = Promise.resolve();
        if (marksSaveTimerRef.current) clearTimeout(marksSaveTimerRef.current);
        setStage("upload");
        setActiveJobId(null);
        setIssues([]);
        setCustomMarks([]);
        setSelectedFile(null);
      }
      await refreshSavedBooks();
    } catch (error: any) {
      setGlobalError(error.message || "Could not delete this proofread");
    }
  };


  const startAnalysis = async (scanTypes: string[], classLevel: string, subject: string, language: string, instructions: string) => {
    if (!selectedFile?.rawFile) return;
    const version = ++viewVersionRef.current;
    try {
      await flushMarksSave();
    } catch (error: any) {
      setGlobalError(error.message || "Could not save manual marks");
      return;
    }
    if (version !== viewVersionRef.current) return;
    marksLoadedRef.current = false;
    activeJobIdRef.current = null;
    setIsRefiningIssues(false);

    setActiveScanTypes(scanTypes);
    setGlobalError(null);
    setAnalysisStatus("queued");
    setActiveJobId(null);
    setResponseData(null);
    setIssues([]);
    refinedBboxRef.current.clear();
    setPages([]);
    setCustomMarks([]);
    setCurrentPage(1);
    setActiveIssueId(null);
    setTotalPages(0);
    setCompletedPages(0);
    setIndexedPages(0);
    setStage("analysis");
    setProgress(0);
    setUploadPhase({ active: true, percent: 0 });
    setHasRestoredSession(true); // Prevent the useEffect from stealing our polling loop
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    let pdfFilename = "";
    let createdJob = false;
    await new Promise(resolve => setTimeout(resolve, 50));

    try {
      const file = selectedFile.rawFile;
      const chunkSize = 9.5 * 1024 * 1024; // 9.5MB chunks to be safe under 10MB Cloudinary raw limit
      const totalSize = file.size;
      const totalParts = Math.ceil(totalSize / chunkSize);
      uploadPartsRef.current = totalParts;
      const baseId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
      
      let start = 0;
      let currentPart = 0;
      
      while (start < totalSize) {
        if (version !== viewVersionRef.current) return;
        const end = Math.min(start + chunkSize, totalSize);
        const chunk = file.slice(start, end);
        
        // Get upload ticket for this specific part
        const urlRes = await fetch((process.env.NEXT_PUBLIC_BASE_PATH || "") + "/api/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type || "application/pdf",
            fileSize: chunk.size,
            baseId,
            partIndex: totalParts > 1 ? currentPart : undefined
          }),
        });
        
        const uploadTicket = await urlRes.json();
        if (!urlRes.ok) throw new Error(uploadTicket.error || "Failed to prepare secure upload");
        
        if (currentPart === 0) {
          // Set the base filename once
          pdfFilename = totalParts > 1 ? uploadTicket.objectKey.replace(/\.part0$/, "") : uploadTicket.objectKey;
          setActivePdfFilename(pdfFilename);
        }

        const formData = new FormData();
        formData.append("file", chunk, file.name);
        formData.append("api_key", uploadTicket.apiKey);
        formData.append("timestamp", uploadTicket.timestamp);
        formData.append("signature", uploadTicket.signature);
        formData.append("public_id", uploadTicket.publicId);

        const uploadRes = await fetch(uploadTicket.uploadUrl, {
          method: "POST",
          body: formData,
        });

        if (!uploadRes.ok) {
          const errText = await uploadRes.text().catch(() => "");
          console.error("Cloudinary chunk error:", errText);
          throw new Error(`PDF upload failed for part ${currentPart}: ${uploadRes.status} ${uploadRes.statusText} - ${errText}`);
        }
        if (version !== viewVersionRef.current) return;
        
        setUploadPhase({ active: true, percent: Math.floor(((currentPart + 1) / totalParts) * 100) });
        start = end;
        currentPart++;
      }
      setUploadPhase({ active: false, percent: 100 });
      setProgress(0);

      const res = await fetch((process.env.NEXT_PUBLIC_BASE_PATH || "") + "/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdfFilename,
          totalParts,
          originalName: selectedFile.name || file.name,
          title: (selectedFile.name || file.name).replace(/\.pdf$/i, ""),
          classLevel,
          subject,
          language: language.toLowerCase().includes("hindi") ? "hindi" : "english",
          bookType: "textbook",
          proofreadingInstructions: instructions,
        }),
      });
      let created: any = {};
      try {
        created = await res.json();
      } catch (e) {
        throw new Error(`Server returned an invalid response (HTTP ${res.status})`);
      }
      if (!res.ok) throw new Error(created?.error || "Failed to start analysis");
      const { jobId, book } = created;
      createdJob = true;
      if (version !== viewVersionRef.current) return;
      activeJobIdRef.current = jobId;
      setActiveJobId(jobId);
      setActivePdfFilename(null);
      setTotalPages(book.pageCount || 0);
      void refreshSavedBooks();

      const poll = async () => {
        if (version !== viewVersionRef.current) return "stale";
        if (pollInFlightRef.current) return "busy";
        pollInFlightRef.current = true;
        try {
        const fetchedReviewVersion = reviewVersionRef.current;
        const statusRes = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/job?id=${encodeURIComponent(jobId)}`, { cache: "no-store" });
        let payload: any = {};
        try {
          payload = await statusRes.json();
        } catch (e) {
          throw new Error(`Server returned an invalid response (HTTP ${statusRes.status})`);
        }
        if (!statusRes.ok) throw new Error(payload?.error || "Could not read analysis status");
        if (!payload?.book) throw new Error("Server returned no book data");
        pollFailuresRef.current = 0;
        if (version !== viewVersionRef.current) return "stale";
        const liveBook = payload.book;
        setAnalysisStatus(liveBook.status);
        const backendPages = payload.pages || [];
        const done = Number(liveBook.progress?.done || 0);
        const failed = Number(liveBook.progress?.failed || 0);
        const expected = Number(liveBook.pageCount || backendPages.length || 0);
        setTotalPages(expected);
        setCompletedPages(done);
        setIndexedPages(Number(liveBook.progress?.indexed || 0));
        setProgress(expected ? Math.min(100, Math.round(((done + failed) / expected) * 100)) : 0);
        setPages(backendPages.map((page: any) => ({
          page_number: page.pageNumber,
          image_url: page.imageUrl,
        })));
        // Show issues incrementally as each page completes — don't wait for 100%
        if (done > 0 && liveBook.status !== "done") {
          const liveData = buildResponse(liveBook, backendPages);
          setResponseData(liveData);
          applyLiveIssues(liveData.issues, fetchedReviewVersion);
          if (!marksLoadedRef.current) {
            marksLoadedRef.current = true;
            skipNextSaveRef.current = true;
            setCustomMarks(Array.isArray(liveBook.customMarks) ? liveBook.customMarks : []);
          }
        }

        if (liveBook.status === "done") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          const data = buildResponse(liveBook, backendPages);
          const normalized = mergeLiveIssues(data.issues, latestIssuesRef.current, fetchedReviewVersion);
          const rawFile = selectedFileRef.current?.rawFile;
          if (rawFile && normalized.length > 0) {
            locateIssuesInPdf(rawFile, normalized).then((refinedIssues) => {
              if (version === viewVersionRef.current) setIssues((current) => applyIssueGeometry(current, refinedIssues as ProofreaderIssue[]));
            }).catch(() => {});
          }
          setResponseData(data);
          setIssues((current) => mergeLiveIssues(normalized, current, fetchedReviewVersion));
          setSelectedFile(prev => prev ? { ...prev, pages: expected } : null);
          if (normalized.length) setActiveIssueId(normalized[0].id);
          void refreshSavedBooks();
          setProgress(100);
          setStage("dashboard");
          marksLoadedRef.current = true;
        } else if (liveBook.status === "error") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          throw new Error(liveBook.error || "Every page failed to analyze");
        } else if (liveBook.status === "paused") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setGlobalError(liveBook.error || "Analysis paused after a provider failure. Resume when ready.");
          void refreshSavedBooks();
        }
        return liveBook.status as string;
        } finally {
          pollInFlightRef.current = false;
        }
      };

      const initialStatus = await poll();
      if (initialStatus !== "done" && initialStatus !== "stale" && version === viewVersionRef.current) {
        pollIntervalRef.current = setInterval(() => {
          poll().catch((error) => {
            if (version !== viewVersionRef.current) return;
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            setGlobalError(error.message || "Analysis status could not be refreshed");
          });
        }, 2000);
      }

    } catch (err: any) {
      if (version !== viewVersionRef.current) return;
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (!createdJob) {
        setProgress(0);
        setStage("upload");
      }
      if (pdfFilename && !createdJob) {
        fetch((process.env.NEXT_PUBLIC_BASE_PATH || "") + "/api/delete-file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ objectKey: pdfFilename, totalParts: uploadPartsRef.current }) }).catch(() => {});
      }
      setGlobalError(err?.message || "Analysis could not be started");
    }
  };

  const handleExport = async (format: "json" | "csv" | "pdf") => {
    if (format === "pdf") {
      // Collect all annotations (AI issues + custom marks) into a unified list
      // Even without a rawFile we can still export a report
      try {
        const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");

        // ── Helper: sanitize text for pdf-lib standard fonts ────────────────────
        const sanitizePdfText = (str: string) => {
          if (!str) return "";
          return str
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/—/g, "-")
            .replace(/–/g, "-")
            .replace(/…/g, "...")
            .replace(/[^\x00-\x7F]/g, ""); // pdf-lib standard fonts only support WinAnsi
        };

        // ── Helper: wrap text into lines of max `maxChars` ──────────────────
        const wrapText = (text: string, maxChars: number): string[] => {
          const cleanText = sanitizePdfText(text);
          const words = (cleanText || "").split(" ");
          const lines: string[] = [];
          let current = "";
          for (const word of words) {
            if (word.length > maxChars) {
              if (current) { lines.push(current.trim()); current = ""; }
              let w = word;
              while (w.length > maxChars) {
                lines.push(w.substring(0, maxChars));
                w = w.substring(maxChars);
              }
              if (w) current = w;
              continue;
            }

            if ((current + " " + word).trim().length > maxChars) {
              if (current) lines.push(current.trim());
              current = word;
            } else {
              current = (current + " " + word).trim();
            }
          }
          if (current) lines.push(current.trim());
          return lines;
        };

        // ── Combine AI issues and custom marks into one annotation list per page ─
        type Annotation = {
          pageNum: number; // 1-indexed
          bbox: { x: number; y: number; w: number; h: number } | null;
          category: string;
          label: string;        // short title e.g. "[1] Grammar"
          segments?: { label: string; text: string }[]; // Structured body segments
          body: string;         // suggestion / comment text
          markType: "ai" | "circle" | "square" | "highlight";
          resolved: boolean;
          ignored: boolean;
        };

        const allAnnotations: Annotation[] = [];

        issues.forEach((issue) => {
          if (issue.ignored) return;
          allAnnotations.push({
            pageNum: (issue.page ?? issue.pageIndex ?? 1) as number,
            bbox: issue.bbox || null,
            category: issue.category || "Issue",
            label: `[A${issue.id}] ${issue.category || "Issue"}`,
            // Structured body segments for clean PDF rendering
            segments: [
              ...(issue.originalText ? [{ label: "Found:", text: `"${issue.originalText}"` }] : []),
              ...(issue.suggestedText ? [{ label: "Fix:",   text: issue.suggestedText }] : []),
              ...(issue.explanation   ? [{ label: "Why:",   text: issue.explanation }]   : []),
            ],
            body: "", // kept for type compat, not used for rendering
            markType: "ai",
            resolved: !!issue.resolved,
            ignored: false,
          });
        });

        customMarks.forEach((mark, idx) => {
          allAnnotations.push({
            pageNum: mark.page,
            bbox: { x: mark.x, y: mark.y, w: mark.w, h: mark.h },
            category: "Manual",
            label: `[M${idx + 1}] ${mark.type === "highlight" ? "Text Highlight" : mark.type + " Mark"}`,
            segments: mark.comment ? [{ label: "Note:", text: mark.comment }] : [],
            body: mark.comment || "",
            markType: mark.type,
            resolved: false,
            ignored: false,
          });
        });

        // Group by page
        const byPage: Record<number, Annotation[]> = {};
        for (const ann of allAnnotations) {
          if (!byPage[ann.pageNum]) byPage[ann.pageNum] = [];
          byPage[ann.pageNum].push(ann);
        }

        // ── Load the original PDF if available, otherwise create a blank report ─
        let srcDoc: Awaited<ReturnType<typeof PDFDocument.load>> | null = null;
        let srcPages: { getSize: () => { width: number; height: number } }[] = [];

        if (selectedFile?.rawFile) {
          const ab = await selectedFile.rawFile.arrayBuffer();
          srcDoc = await PDFDocument.load(ab, { ignoreEncryption: true });
          srcPages = srcDoc.getPages();
        }

        const outDoc = await PDFDocument.create();
        const helveticaBold = await outDoc.embedFont(StandardFonts.HelveticaBold);
        const helvetica = await outDoc.embedFont(StandardFonts.Helvetica);

        const SCALE = 0.75; // Original page content takes left 75%
        const LINE_HEIGHT = 9;
        const FONT_SIZE_TITLE = 8;
        const FONT_SIZE_BODY = 7;
        const MARGIN_PAD = 8;
        const CONNECTOR_RED = rgb(0.85, 0.15, 0.15);
        const RED = rgb(0.87, 0.18, 0.18);
        const GREEN = rgb(0.1, 0.65, 0.3);
        const PURPLE = rgb(0.5, 0.15, 0.75);
        const BLUE = rgb(0.1, 0.35, 0.8);
        const GRAY_TEXT = rgb(0.2, 0.2, 0.2);
        const SEPARATOR = rgb(0.8, 0.8, 0.8);

        const pageKeys = Object.keys(byPage).map(Number);
        const totalPages = srcPages.length || (pageKeys.length > 0 ? Math.max(...pageKeys) : 1);

        for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
          // Original page dimensions
          let origW = 595; // A4 default
          let origH = 842;
          if (srcPages[pageIdx]) {
            const sz = srcPages[pageIdx].getSize();
            origW = sz.width;
            origH = sz.height;
          }

          // New page is same size as original
          const newPage = outDoc.addPage([origW, origH]);

          // ── Draw scaled source content ────────────────────────────────────
          const scaledW = origW * SCALE;
          const scaledH = origH * SCALE;

          if (srcDoc && srcPages[pageIdx]) {
            try {
              const [embeddedPage] = await outDoc.embedPdf(srcDoc, [pageIdx]);
              if (embeddedPage) {
                // pdf-lib origin is bottom-left; place scaled page at top-left
                newPage.drawPage(embeddedPage, {
                  x: 0,
                  y: origH - scaledH,
                  width: scaledW,
                  height: scaledH,
                });
              }
            } catch (embedErr) {
              console.warn(`Could not embed page ${pageIdx + 1}:`, embedErr);
            }
          }

          // ── Separator lines ───────────────────────────────────────────────
          const sepX = scaledW;
          const sepY = origH - scaledH; // horizontal separator Y (from bottom)
          // Vertical line
          newPage.drawLine({
            start: { x: sepX, y: 0 },
            end: { x: sepX, y: origH },
            color: SEPARATOR,
            thickness: 1,
          });
          // Horizontal line (bottom boundary of scaled content)
          newPage.drawLine({
            start: { x: 0, y: sepY },
            end: { x: scaledW, y: sepY },
            color: SEPARATOR,
            thickness: 1,
          });

          // ── Annotation header in right margin ─────────────────────────────
          const marginX = scaledW + MARGIN_PAD;
          const marginW = origW - scaledW - MARGIN_PAD * 2;
          newPage.drawText("CORRECTIONS", {
            x: marginX,
            y: origH - 14,
            size: 6,
            font: helveticaBold,
            color: rgb(0.6, 0.6, 0.6),
          });

          // ── Per-page annotations ──────────────────────────────────────────
          const pageAnns = byPage[pageIdx + 1] || [];

          // Sort by Y coordinate (top-down in % space)
          pageAnns.sort((a, b) => (a.bbox?.y ?? 0) - (b.bbox?.y ?? 0));

          let currentMarginY = origH - 22; // Start below header

          // First pass: calculate box heights and initial Y positions
          // Each segment renders its label INLINE with the text on the same row,
          // so we need both the pixel width of the label and the wrap budget.
          interface InlineSeg {
            labelStr:   string;   // e.g. "Found: "
            labelW:     number;   // pt width of labelStr at FONT_SIZE_BODY
            firstLine:  string;   // text chunk that fits on the label row
            contLines:  string[]; // continuation lines (indented by labelW)
          }
          interface MarginBox {
            ann: any;
            boxH: number;
            boxY: number;
            titleLines: string[];
            inlineSegs: InlineSeg[];
            bx: number;
            bw: number;
            bCenterY: number;
            drawX?: number;
          }

          const marginBoxes: MarginBox[] = [];

          // Avg char width at FONT_SIZE_BODY in Helvetica ≊ 4.0 pt/char
          const AVG_CHAR_W = 4.0;
          const SEP_H = 4; // separator + padding below title
          const SEG_GAP = 2; // tiny gap between segments

          for (const ann of pageAnns) {
            try {
              const bx = ann.bbox ? (ann.bbox.x / 100) * scaledW : 0;
              const by = ann.bbox ? (ann.bbox.y / 100) * scaledH : 0;
              const bw = ann.bbox ? (ann.bbox.w / 100) * scaledW : 0;
              const bh = ann.bbox ? (ann.bbox.h / 100) * scaledH : 0;

              const byFromBottom = origH - scaledH + ((1 - ((ann.bbox?.y ?? 0) + (ann.bbox?.h ?? 0)) / 100) * scaledH);
              const bCenterY = byFromBottom + bh / 2;

              const maxCharsPerLine = Math.floor(marginW / AVG_CHAR_W);
              const titleLines = wrapText(ann.label, maxCharsPerLine);

              const segments: { label: string; text: string }[] = ann.segments?.length
                ? ann.segments
                : (ann.body ? [{ label: "", text: ann.body }] : []);

              // For each segment, compute inline layout
              const inlineSegs: InlineSeg[] = segments.map((seg: { label: string; text: string }) => {
                const labelStr = seg.label ? seg.label + " " : "";
                const labelW   = helveticaBold.widthOfTextAtSize(labelStr, FONT_SIZE_BODY);
                // How many chars fit on the first line (label takes some width)
                const firstChars = Math.max(4, Math.floor((marginW - labelW) / AVG_CHAR_W));
                const contChars  = Math.max(4, Math.floor((marginW - labelW) / AVG_CHAR_W));

                // Split text: first chunk + continuation
                const words = sanitizePdfText(seg.text).split(" ").filter(Boolean);
                const lines: string[] = [];
                let cur = "";
                for (const word of words) {
                  const budget = lines.length === 0 ? firstChars : contChars;
                  if ((cur + (cur ? " " : "") + word).length > budget) {
                    if (cur) lines.push(cur);
                    cur = word.length > budget ? word.slice(0, budget) : word;
                  } else {
                    cur = cur ? cur + " " + word : word;
                  }
                }
                if (cur) lines.push(cur);

                return {
                  labelStr,
                  labelW,
                  firstLine:  lines[0] || "",
                  contLines:  lines.slice(1),
                };
              });

              // Box height: top-pad + title + sep + segments + bottom-pad
              const segH = inlineSegs.reduce((sum, s, i) => {
                const rows = 1 + s.contLines.length; // firstLine row + cont rows
                return sum + (rows * LINE_HEIGHT) + (i < inlineSegs.length - 1 ? SEG_GAP : 0);
              }, 0);
              const boxH = Math.max(16, 4 + (titleLines.length * LINE_HEIGHT) + SEP_H + segH + 3);

              let boxY: number;
              if (ann.bbox) {
                boxY = Math.min(currentMarginY, bCenterY + boxH / 2);
              } else {
                boxY = currentMarginY;
              }

              marginBoxes.push({ ann, boxH, boxY, titleLines, inlineSegs, bx, bw, bCenterY });
              currentMarginY = boxY - boxH - 4;
            } catch (err: any) {
              console.warn(`Error in pass 1 for ${ann.label}`, err);
            }
          }

          // Second pass: resolve bottom collisions by pushing the stack up
          // If the last box goes off the bottom (boxY - boxH < 4), we have a deficit
          if (marginBoxes.length > 0) {
            const lastBox = marginBoxes[marginBoxes.length - 1];
            const lowestPoint = lastBox.boxY - lastBox.boxH;
            if (lowestPoint < 4) {
              const deficit = 4 - lowestPoint;
              
              // Push all boxes up by the deficit
              // BUT ensure the top box doesn't get pushed off the page!
              const firstBox = marginBoxes[0];
              const maxDeficit = Math.max(0, (origH - 4) - firstBox.boxY);
              const actualDeficit = Math.min(deficit, maxDeficit);

              for (const box of marginBoxes) {
                box.boxY += actualDeficit;
              }
            }
          }

          // Third pass: Overflow into bottom columns if they still fall off the page
          const bottomCols = [
            { x: 10, startY: origH - scaledH - 10 },
            { x: 10 + marginW + 10, startY: origH - scaledH - 10 },
            { x: 10 + (marginW + 10) * 2, startY: origH - scaledH - 10 },
            { x: 10 + (marginW + 10) * 3, startY: origH - scaledH - 10 }
          ];
          let colIdx = 0;
          let colY = bottomCols[0].startY;

          for (const box of marginBoxes) {
            if (box.boxY - box.boxH < 4) {
              // Move this box to the bottom columns
              box.drawX = bottomCols[colIdx].x;
              box.boxY = colY;
              
              colY -= (box.boxH + 4);
              if (colY - 20 < 4 && colIdx < bottomCols.length - 1) {
                 colIdx++;
                 colY = bottomCols[colIdx].startY;
              }
            } else {
              box.drawX = marginX;
            }
          }

          // Fourth pass: Draw them
          for (const box of marginBoxes) {
            const { ann, boxH, boxY, titleLines, inlineSegs, bx, bw, bCenterY, drawX } = box as any;
            const finalDrawX = drawX ?? marginX;
            const isResolved = ann.resolved;
            const color = isResolved ? GREEN : (ann.markType === "circle" ? BLUE : ann.markType === "square" ? PURPLE : ann.markType === "highlight" ? rgb(0.8, 0.6, 0.1) : RED);

            try {
              if (ann.bbox) {
                if (ann.markType === "circle") {
                  newPage.drawCircle({ x: bx + bw / 2, y: bCenterY, size: Math.max(bw, (ann.bbox.h / 100 * scaledH)) / 2, borderWidth: 1.5, borderColor: BLUE, opacity: 0.85 });
                } else if (ann.markType === "square") {
                  newPage.drawRectangle({ x: bx, y: bCenterY - (ann.bbox.h / 100 * scaledH)/2, width: bw, height: (ann.bbox.h / 100 * scaledH), borderWidth: 1.5, borderColor: PURPLE, opacity: 0.85 });
                } else if (ann.markType === "highlight") {
                  newPage.drawRectangle({ x: bx, y: bCenterY - (ann.bbox.h / 100 * scaledH)/2, width: bw, height: (ann.bbox.h / 100 * scaledH), color: rgb(1, 0.9, 0.2), opacity: 0.4 });
                } else {
                  newPage.drawLine({ start: { x: bx, y: bCenterY - (ann.bbox.h / 100 * scaledH)/2 }, end: { x: bx + bw, y: bCenterY - (ann.bbox.h / 100 * scaledH)/2 }, color: isResolved ? GREEN : RED, thickness: 1.5 });
                }

                // ── Connector dashed line ──────────────────────────────────────
                const connStart = { x: bx + bw, y: bCenterY };
                newPage.drawLine({
                  start: connStart,
                  end: { x: finalDrawX, y: boxY - boxH / 2 },
                  color: CONNECTOR_RED,
                  thickness: 0.5,
                  dashArray: [2, 2],
                });
                // Small solid black dot at the connector origin (on the bbox side)
                newPage.drawCircle({
                  x: connStart.x,
                  y: connStart.y,
                  size: 2,
                  color: rgb(0, 0, 0),
                  opacity: 0.85,
                });
              }

              // ── Comment box background ─────────────────────────────────────
              newPage.drawRectangle({
                x: finalDrawX - 2,
                y: boxY - boxH,
                width: marginW + 4,
                height: boxH,
                color: rgb(1, 1, 1),
                borderColor: color,
                borderWidth: 0.75,
                opacity: 0.95,
              });

              // ── Title text ───────────────────────────────────────────────
              let textY = boxY - 4 - FONT_SIZE_TITLE;
              for (const line of titleLines) {
                newPage.drawText(line, {
                  x: finalDrawX + 2, y: textY,
                  size: FONT_SIZE_TITLE, font: helveticaBold, color,
                });
                textY -= LINE_HEIGHT;
              }

              textY -= 4; // padding between title and body segments

              // ── Inline-label body segments ──────────────────────────────────
              // Label and first line of text share the same row.
              // Continuation lines are indented by exactly labelW pts.
              for (let si = 0; si < inlineSegs.length; si++) {
                const seg = inlineSegs[si];
                const tx = finalDrawX + 2;

                // Draw label (bold, accent color) + first text chunk side-by-side
                if (seg.labelStr) {
                  newPage.drawText(seg.labelStr, {
                    x: tx, y: textY,
                    size: FONT_SIZE_BODY, font: helveticaBold, color,
                  });
                }
                if (seg.firstLine) {
                  newPage.drawText(seg.firstLine, {
                    x: tx + seg.labelW, y: textY,
                    size: FONT_SIZE_BODY, font: helvetica, color: GRAY_TEXT,
                  });
                }
                textY -= LINE_HEIGHT;

                // Continuation lines indented to align under text (not label)
                for (const contLine of seg.contLines) {
                  newPage.drawText(contLine, {
                    x: tx + seg.labelW, y: textY,
                    size: FONT_SIZE_BODY, font: helvetica, color: GRAY_TEXT,
                  });
                  textY -= LINE_HEIGHT;
                }

                // Tiny gap between segments
                if (si < inlineSegs.length - 1) textY -= 2;
              }
            } catch (annErr: any) {
              console.warn(`Skipping annotation ${ann.label}:`, annErr);
            }
          }

          // ── Page number ───────────────────────────────────────────────────
          newPage.drawText(`Page ${pageIdx + 1} of ${totalPages}`, {
            x: origW / 2 - 20,
            y: 8,
            size: 7,
            font: helvetica,
            color: rgb(0.6, 0.6, 0.6),
          });
        }

        const pdfBytes = await outDoc.save();
        const blob = new Blob([pdfBytes as unknown as BlobPart], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `proofread-annotated-${selectedFile?.name || "document.pdf"}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } catch (err: any) {
        console.error("Failed to generate annotated PDF:", err);
        alert(`Export failed: ${err?.message || "Unknown error"}. Please try CSV export as a fallback.`);
      }
      return;
    }

    if (format === "csv") {
      const csvRows = [
        ["ID", "Category", "Type", "Severity", "Original Text", "Suggested Text", "Explanation", "Page", "Status"],
        ...issues.map((i) => [
          i.id,
          i.category,
          i.type,
          i.severity,
          i.originalText,
          i.suggestedText,
          i.explanation,
          i.page || 1,
          i.resolved ? "Resolved" : i.ignored ? "Ignored" : "Pending"
        ])
      ];
      const csvContent = csvRows.map(e => e.map(val => `"${String(val).replace(/"/g, '""')}"`).join(",")).join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `proofread-${selectedFile?.name || "export"}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      return;
    }

    const exportData = JSON.stringify(responseData, null, 2);
    const blob = new Blob([exportData], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `proofread-${selectedFile?.name || "export"}.${format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const toggleAnalysisPause = async () => {
    if (!activeJobId) return;
    const version = viewVersionRef.current;
    const jobId = activeJobId;
    const action = analysisStatus === "paused" || analysisStatus === "error" ? "resume" : "pause";
    const previousStatus = analysisStatus;
    // Optimistic update for instant smooth UI feedback
    setAnalysisStatus(action === "pause" ? "paused" : "queued");
    
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/books/${encodeURIComponent(jobId)}/${action}`, { method: "POST" });
      let payload: any = {};
      try {
        payload = await response.json();
      } catch (e) {
        throw new Error(`Server returned an invalid response (HTTP ${response.status})`);
      }
      if (!response.ok) throw new Error(payload?.error || `Could not ${action} analysis`);
      if (version !== viewVersionRef.current || activeJobIdRef.current !== jobId) return;
      // Update with server truth
      setAnalysisStatus(payload.book.status);
      if (action === "resume") {
        // The poller was stopped when the job paused/errored; restart it so
        // newly found issues stream onto the canvas immediately.
        setGlobalError(null);
        const known = savedBooks.find((b) => b.id === activeJobId);
        startLivePolling(known ?? ({
          id: activeJobId,
          title: selectedFile?.subject || selectedFile?.name?.replace(/\.pdf$/i, "") || "Untitled",
          originalName: selectedFile?.name,
          pageCount: totalPages,
          status: payload.book.status,
        } as SavedBook));
      } else if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    } catch (error: any) {
      if (version !== viewVersionRef.current || activeJobIdRef.current !== jobId) return;
      // Rollback on failure
      setAnalysisStatus(previousStatus);
      setGlobalError(error.message || "Analysis control failed");
    }
  };

  const updateIssueStatus = async (issue: ProofreaderIssue, status: "open" | "accepted" | "dismissed") => {
    if (!activeJobId || !issue.backendUid || !issue.page) return;
    pendingStatusRef.current.set(issue.backendUid, status);
    reviewVersionRef.current++;
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/books/${encodeURIComponent(activeJobId)}/pages/${issue.page}/issues/${encodeURIComponent(issue.backendUid)}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }
    );
      if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Could not save review decision");
      }
    } finally {
      pendingStatusRef.current.delete(issue.backendUid);
      reviewVersionRef.current++;
    }
  };

  useEffect(() => {
    setResponseData((current) => current ? { ...current, issues } : current);
  }, [issues]);

  const resetSession = async () => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    try { await flushMarksSave(); } catch (error: any) {
      setGlobalError(error.message || "Could not save manual marks"); return;
    }
    viewVersionRef.current++;
    setIsRefiningIssues(false);
    if (activeJobId && ["queued", "processing"].includes(analysisStatus)) {
      try {
        await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/books/${encodeURIComponent(activeJobId)}/pause`, { method: "POST", keepalive: true });
      } catch (err) {
        console.warn("Failed to pause proofread:", err);
      }
    }
    activeJobIdRef.current = null;
    setActiveJobId(null);

    // DO NOT delete the temporary file from Cloudinary storage here.
    // The Vercel function requires this file to exist so it can download it to
    // /tmp when resuming the paused book. It is deleted only when the proofread
    // is permanently deleted via `deleteSavedBook`.
    setActivePdfFilename(null);

    setSelectedFile(null);
    setProgress(0);
    setAnalysisStatus("queued");
    setResponseData(null);
    setPages([]);
    setIssues([]);
    marksLoadedRef.current = false;
    setCustomMarks([]);
    setCurrentPage(1);
    setActiveIssueId(null);
    setStage("upload");
    void refreshSavedBooks();
  };

  const resolvedCount = issues.filter((i) => i.resolved || i.ignored).length + customMarks.length;
  const totalCount = issues.length + customMarks.length;

  if (!isClient) return null;

  return (
    <div className="flex h-screen w-full bg-[#F8FAFC] text-slate-900 overflow-hidden font-sans selection:bg-brand-500/20 selection:text-brand-700">
      
      <AppSidebar
        stage={stage}
        setStage={setStage}
        isSidebarExpanded={isSidebarExpanded}
        setIsSidebarExpanded={setIsSidebarExpanded}
        sidebarActiveTab={sidebarActiveTab}
        setSidebarActiveTab={setSidebarActiveTab}
        selectedFile={selectedFile}
        totalPages={totalPages}
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        issues={issues}
      />

      <AgenticBot
        key={activeJobId || "no-project"}
        bookId={activeJobId}
        pageNumber={currentPage}
        stage={stage}
        projectTitle={selectedFile?.name}
        sidebarIssueMap={issues.map((issue,index)=>({number:index+1,uid:issue.backendUid!,page:issue.page!})).filter(issue=>issue.uid && issue.page)}
        activeIssueUid={issues.find((issue) => issue.id === activeIssueId)?.backendUid}
        onNavigatePage={(page) => { setCurrentPage(page); setStage("review"); }}
        onAnalysisAction={async () => {
          if (!activeJobId || !selectedFile) return;
          const saved = savedBooks.find((book) => book.id === activeJobId) || {
            id: activeJobId, title: selectedFile.subject, originalName: selectedFile.name,
            pageCount: totalPages, status: analysisStatus,
          };
          await openSavedBook(saved, true);
        }}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 relative bg-[#F8FAFC] overflow-hidden">
        
        {/* Background glow graphics */}
        <div className="absolute top-[-10%] right-[-10%] w-[500px] h-[500px] rounded-full bg-brand-500/5 blur-[120px] pointer-events-none" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[500px] h-[500px] rounded-full bg-blue-500/5 blur-[120px] pointer-events-none" />

        {/* Global Toast */}
        {globalError && (
          <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[200] bg-white border border-red-200 shadow-xl rounded-xl px-5 py-3.5 flex items-center gap-3 animate-in fade-in slide-in-from-top-4 duration-300">
            <AlertCircle className="h-5 w-5 text-red-500 shrink-0" />
            <p className="text-sm font-semibold text-slate-800">{globalError}</p>
            <button onClick={() => setGlobalError(null)} className="ml-2 text-slate-400 hover:text-slate-600 p-1 rounded-full hover:bg-slate-100 transition-colors">
               <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <AnimatePresence mode="wait">
          {sidebarActiveTab === "settings" ? (
            <motion.div
              key="settings"
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="flex-1 p-8 overflow-y-auto max-w-4xl mx-auto space-y-6 custom-scrollbar"
            >
              <SettingsView />
            </motion.div>
          ) : (
            <motion.div
              key="proofreader-main"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="flex-1 w-full mx-auto px-4 xl:px-6 py-4 flex flex-col overflow-hidden relative z-10 min-h-0 min-w-0 max-w-5xl"
            >
              {/* Premium Stepper Navigation */}
              <div className="shrink-0 z-30 mb-4 w-full max-w-5xl mx-auto flex items-center justify-between gap-4">
                <div className="flex-1 bg-white/80 backdrop-blur-sm rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.06)] border border-slate-200/80 px-3 py-2 flex relative overflow-hidden">

                  {/* Animated background progress track */}
                  <div className="absolute inset-y-2 left-3 right-3 rounded-xl bg-slate-50/80 pointer-events-none" />

                  {[
                    { key: "upload",   num: "01", label: "Project Setup", icon: UploadCloud },
                    { key: "analysis", num: "02", label: "AI Analysis",  icon: RefreshCw   },
                    { key: "dashboard",num: "03", label: "Scorecard",    icon: BarChart3   },
                    { key: "review",   num: "04", label: "Review",       icon: Edit3       },
                    { key: "export",   num: "05", label: "Export",       icon: Download    },
                  ].map((step, idx) => {
                    const isCompleted = idx < stageOrder.indexOf(stage);
                    const isActive = stage === step.key;
                    const isAvailable = step.key === "upload"
                      || (step.key === "analysis" ? !!activeJobId : false)
                      // Dashboard and Review unlock as soon as 1 page is done
                      || ((step.key === "dashboard" || step.key === "review") && (!!responseData || completedPages > 0))
                      // Export only after full completion
                      || (step.key === "export" && !!responseData && analysisStatus === "done");

                    return (
                      <React.Fragment key={step.key}>
                        <button
                          onClick={() => isAvailable && setStage(step.key as any)}
                          disabled={!isAvailable}
                          className="flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-xl relative z-10 focus:outline-none group transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {/* Animated active pill */}
                          {isActive && (
                            <motion.div
                              layoutId="stepper-pill"
                              className="absolute inset-0 rounded-xl bg-gradient-to-r from-brand-500 to-brand-600 shadow-lg shadow-brand-500/30"
                              transition={{ type: "spring", stiffness: 380, damping: 34 }}
                            />
                          )}

                          {/* Step badge */}
                          <div className={`relative z-10 flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-black transition-all duration-300 ${
                            isActive
                              ? "bg-white/25 text-white ring-1 ring-white/40"
                              : isCompleted
                              ? "bg-slate-200/90 text-slate-700"
                              : "bg-slate-200/80 text-slate-400 group-hover:bg-slate-300/60 group-hover:text-slate-600"
                          }`}>
                            {isCompleted
                              ? <CheckSquare className="h-3 w-3" />
                              : <span>{step.num}</span>
                            }
                          </div>

                          {/* Label */}
                          <span className={`relative z-10 text-[12.5px] font-semibold tracking-tight whitespace-nowrap transition-all duration-300 ${
                            isActive
                              ? "text-white"
                              : isCompleted
                              ? "text-slate-700"
                              : "text-slate-400 group-hover:text-slate-600"
                          }`}>
                            {step.label}
                          </span>
                        </button>
                      </React.Fragment>
                    );
                  })}
                </div>
                {activeJobId && (
                  <button
                    onClick={() => setIsMemoryEditorOpen(true)}
                    className="relative flex-shrink-0 group flex items-center justify-center gap-2.5 px-6 py-2 rounded-xl transition-all duration-300 hover:bg-slate-50 active:bg-slate-100 ml-1"
                  >
                    <div className="relative z-10 flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-black transition-all duration-300 bg-slate-200/80 text-slate-400 group-hover:bg-slate-300/60 group-hover:text-slate-600">
                      <Database className="h-3 w-3" />
                    </div>
                    <span className="relative z-10 text-[12.5px] font-semibold tracking-tight whitespace-nowrap transition-all duration-300 text-slate-400 group-hover:text-slate-600">
                      Chapter Memory
                    </span>
                  </button>
                )}
              </div>

              {/* Dynamic Stage Body */}
              <div className="flex-1 min-h-0 relative flex flex-col overflow-hidden">
                <AnimatePresence mode="wait">
                  {stage === "upload" && (
                    <motion.div
                      key="upload"
                      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.2 }}
                      className="flex-1 min-h-0 flex flex-col overflow-hidden"
                    >
                      <UploadStage
                        selectedFile={selectedFile} onFileSelect={handleFileSelect} onStartAnalysis={startAnalysis}
                        onFileNameChange={(newName) => setSelectedFile(prev => prev ? { ...prev, name: newName } : null)}
                        savedBooks={savedBooks} savedBooksLoading={savedBooksLoading} onOpenSaved={openSavedBook}
                        onDeleteSaved={deleteSavedBook}
                      />
                    </motion.div>
                  )}

                  {stage === "analysis" && (
                    <motion.div
                      key="analysis"
                      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.2 }}
                      className="flex-1 flex flex-col overflow-hidden"
                    >
                      <AnalysisStage
                        progress={progress} totalPages={totalPages} completedPages={completedPages}
                        fileName={selectedFile?.name} fileSize={selectedFile?.size} selectedScanTypes={activeScanTypes}
                        status={analysisStatus} onPauseToggle={toggleAnalysisPause}
                        uploadPhase={uploadPhase} indexedPages={indexedPages}
                        onCancel={resetSession} onViewReport={() => setStage(analysisStatus === "done" ? "dashboard" : "review")}
                        onReviewContext={() => setIsMemoryEditorOpen(true)}
                      />
                    </motion.div>
                  )}

                  {stage === "dashboard" && (
                    <motion.div
                      key="dashboard"
                      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.2 }}
                      className="flex-1 min-h-0 flex flex-col overflow-hidden"
                    >
                      <DashboardStage
                        data={responseData} onReviewIssue={(id) => { setActiveIssueId(id); setStage("review"); }}
                        onLaunchReview={() => setStage("review")} onExport={handleExport as any}
                        selectedFile={selectedFile}
                      />
                    </motion.div>
                  )}

                  {stage === "review" && (
                    <motion.div
                      key="review"
                      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.2 }}
                      className="flex-1 min-h-0 flex flex-col overflow-hidden"
                    >
                      <ReviewStage
                        key={activeJobId || "no-project"}
                        selectedFile={selectedFile}
                        issues={issues} setIssues={setIssues} customMarks={customMarks} setCustomMarks={setCustomMarks}
                        currentPage={currentPage} setCurrentPage={setCurrentPage} activeIssueId={activeIssueId}
                        setActiveIssueId={setActiveIssueId} pages={pages} onNext={() => setStage("export")}
                        onIssueStatus={updateIssueStatus}
                        isRefiningIssues={isRefiningIssues}
                        analysisWarnings={responseData?.perPage?.find((page: any) => page.pageNumber === currentPage)?.analysisWarnings || []}
                      />
                    </motion.div>
                  )}

                  {stage === "export" && (
                    <motion.div
                      key="export"
                      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.2 }}
                      className="flex-1 min-h-0 flex flex-col overflow-hidden"
                    >
                      <ExportStage
                        onResetSession={resetSession} onExport={handleExport} fileName={selectedFile?.name}
                        fileSize={selectedFile?.size} totalAnnotations={totalCount}
                        hasActiveFile={!!selectedFile?.rawFile}
                        allWarnings={Array.from(new Set(responseData?.perPage?.flatMap((p: any) => p.analysisWarnings || [])))}
                        totalTokens={responseData?.perPage?.reduce((acc: number, p: any) => acc + (p.tokensUsed || 0), 0) || 0}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Status Bar matching Stepper width and rounded-2xl card design */}
              <div className="mt-3 shrink-0 bg-white/90 backdrop-blur-md px-5 py-2 h-11 rounded-2xl border border-slate-200/80 flex justify-between items-center shadow-[0_4px_24px_rgba(0,0,0,0.04)] z-30 w-full max-w-5xl mx-auto">
                  <div className="flex items-center gap-3">
                    {selectedFile ? (
                      <>
                        <div className="inline-flex items-center gap-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200/80 px-2.5 py-0.5 rounded-full text-[10px] font-mono font-extrabold tracking-wider shadow-2xs">
                          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                          <span>SESSION ACTIVE</span>
                        </div>
                        <div className="w-1 h-1 rounded-full bg-slate-300" />
                        <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200/60 px-2.5 py-0.5 rounded-md text-slate-700 font-bold text-xs font-mono">
                          <FileText className="h-3.5 w-3.5 text-slate-400" />
                          <span className="truncate max-w-sm">{selectedFile.name}</span>
                        </div>
                      </>
                    ) : (
                      <div className="inline-flex items-center gap-1.5 bg-slate-100 text-slate-500 border border-slate-200/80 px-2.5 py-0.5 rounded-full text-[10px] font-mono font-extrabold tracking-wider shadow-2xs">
                        <span className="w-2 h-2 rounded-full bg-slate-400" />
                        <span>NO ACTIVE SESSION</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 bg-slate-50 border border-slate-200/80 px-3 py-0.5 rounded-lg shadow-2xs">
                      <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Reviewed:</span>
                      <span className="text-slate-900 font-mono font-bold text-xs">{resolvedCount} / {totalCount}</span>
                      {totalCount > 0 && (
                        <div className="w-12 h-1.5 bg-slate-200 rounded-full overflow-hidden ml-1">
                          <div 
                            className="h-full bg-emerald-500 transition-all duration-300"
                            style={{ width: `${(resolvedCount / totalCount) * 100}%` }}
                          />
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => setShowTerminateConfirm(true)}
                      disabled={!selectedFile}
                      className={`px-3 py-0.5 rounded-lg transition-all font-bold text-xs shadow-2xs ${
                        selectedFile 
                          ? "bg-red-50 hover:bg-red-100 text-red-700 border border-red-200/80 active:scale-[0.98]" 
                          : "bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed"
                      }`}
                    >
                      End Session
                    </button>
                  </div>
                </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Terminate Modal */}
      {showTerminateConfirm && isClient && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }}
            className="bg-white rounded-2xl w-full max-w-sm p-8 border border-slate-200 shadow-2xl"
          >
            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mb-4">
              <AlertCircle className="h-6 w-6 text-red-600" />
            </div>
            <h3 className="text-xl font-bold text-slate-900 mb-2">End Session?</h3>
            <p className="text-slate-500 text-sm mb-8 leading-relaxed font-medium">
              {analysisStatus === "done"
                ? "This closes the current view. The completed proofread and review decisions stay saved in Recent proofreads."
                : "This closes the current view. The unfinished analysis is paused and kept in Recent proofreads — you can resume it anytime."}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowTerminateConfirm(false)}
                className="flex-1 px-4 py-2.5 rounded-lg text-sm font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowTerminateConfirm(false); resetSession(); }}
                className="flex-1 px-4 py-2.5 rounded-lg text-sm font-bold text-white bg-red-600 hover:bg-red-700 transition-colors shadow-sm"
              >
                End Session
              </button>
            </div>
          </motion.div>
        </div>,
        document.body
      )}

      {createPortal(
        <AnimatePresence>
          {isMemoryEditorOpen && activeJobId && (
            <ChapterMemoryEditor
              bookId={activeJobId}
              onClose={() => setIsMemoryEditorOpen(false)}
              onApprove={() => setAnalysisStatus("queued")}
            />
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}
