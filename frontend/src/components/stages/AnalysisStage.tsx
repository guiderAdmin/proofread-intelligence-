"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Pause, Play, FileText, ChevronRight, AlertCircle, Sparkles, Terminal, Cpu, Eye, BookOpen, Layers, ShieldCheck, Zap } from "lucide-react";

interface AnalysisStageProps {
  progress: number;
  totalPages?: number;
  completedPages?: number;
  indexedPages?: number;
  fileName?: string;
  fileSize?: string;
  selectedScanTypes?: string[];
  status?: "queued" | "context_approval" | "processing" | "paused" | "done" | "error";
  uploadPhase?: { active: boolean; percent: number };
  onPauseToggle: () => void;
  onCancel: () => void;
  onViewReport: () => void;
  onReviewContext?: () => void;
}

interface PipelineStep {
  id: string;
  title: string;
  desc: string;
  info: string;
  icon: any;
  metric: string;
}

export function AnalysisStage({
  progress,
  totalPages = 0,
  completedPages = 0,
  indexedPages = 0,
  fileName = "document.pdf",
  fileSize = "0.0 MB",
  selectedScanTypes = ["grammar", "object", "fact"],
  status = "queued",
  uploadPhase = { active: false, percent: 0 },
  onPauseToggle,
  onCancel,
  onViewReport,
  onReviewContext,
}: AnalysisStageProps) {
  const [eta, setEta] = useState<number>(30);
  const isPaused = status === "paused";
  const isComplete = status === "done";
  const hasFailed = status === "error";

  useEffect(() => {
    if (progress === 0 || totalPages === 0) {
      setEta(30);
    } else if (progress > 0 && progress < 100) {
      const remainingPages = Math.max(0, totalPages - completedPages);
      setEta(Math.max(2, remainingPages * 3));
    } else {
      setEta(0);
    }
  }, [progress, totalPages, completedPages]);

  const dynamicSteps: PipelineStep[] = [
    {
      id: "ocr",
      title: "OCR & Vector Layout Parser",
      desc: "Decompressing PDF vector blocks, tables & font mappings...",
      info: "Page text and layout evidence saved for review.",
      icon: Cpu,
      metric: "PDF text and OCR"
    }
  ];

  if (selectedScanTypes.includes("grammar")) {
    dynamicSteps.push({
      id: "grammar",
      title: "Syntactic NLP & Readability Audit",
      desc: "Evaluating grade-level readability, grammar & syntax models...",
      info: "Language findings saved for review.",
      icon: Layers,
      metric: "Language checks"
    });
  }

  if (selectedScanTypes.includes("objects") || selectedScanTypes.includes("object")) {
    dynamicSteps.push({
      id: "object",
      title: "Visual Asset Vision Pipeline",
      desc: "Extracting math equations, visual figures, and diagram captions...",
      info: "Visual findings saved. Verify any estimated locations during review.",
      icon: Eye,
      metric: "Visual checks"
    });
  }

  if (selectedScanTypes.includes("deep") || selectedScanTypes.includes("fact")) {
    dynamicSteps.push({
      id: "fact",
      title: "Pedagogical & Syllabus Validator",
      desc: "Reviewing factual claims and educational consistency...",
      info: "Educational findings saved for review.",
      icon: BookOpen,
      metric: "Educational checks"
    });
  }

  const numSteps = dynamicSteps.length;
  const stepWeight = 100 / numSteps;

  const radius = 68;
  const circ = 2 * Math.PI * radius;
  const strokeDashoffset = circ - (progress / 100) * circ;

  return (
    <div className="flex-grow flex flex-col justify-start w-full space-y-4 relative z-10 font-sans min-h-0 overflow-y-auto custom-scrollbar pr-1">

      {!uploadPhase.active && totalPages > 0 && indexedPages < totalPages && completedPages === 0 && (
        <div className="shrink-0 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
          Preparing chapter evidence: {indexedPages} / {totalPages} pages.
          <p className="mt-1 text-xs">Page text is prepared before the single AI review so it can use the full chapter context.</p>
        </div>
      )}


      
      {/* Light Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-3 border-b border-slate-200/70 shrink-0">
        <div>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-brand-50 text-brand-700 text-[10px] font-bold uppercase tracking-wider rounded-md border border-brand-100/80 mb-1">
            <Sparkles className="h-3 w-3 animate-pulse" />
            <span>Durable Page Analysis</span>
          </div>
          <h2 className="text-xl font-extrabold text-slate-900 tracking-tight leading-tight">AI Orchestrator Parsing</h2>
          <p className="text-xs text-slate-500 mt-0.5">Rendering, checking, and saving each page through the internal MongoDB-backed queue.</p>
        </div>
        
        <div className="shrink-0 self-start md:self-auto flex items-center gap-3">
          {!isComplete && !hasFailed && (
            <div className="px-3.5 py-1.5 bg-white border border-brand-200/80 rounded-lg flex items-center gap-2 shadow-2xs">
              <Loader2 className={`h-3.5 w-3.5 text-brand-500 ${isPaused ? "" : "animate-spin"}`} />
              <span className="text-[11px] font-bold text-brand-600 uppercase tracking-wider font-mono">
                {isPaused ? `${progress}% Paused` : `${progress}% In Progress`}
              </span>
            </div>
          )}
          {hasFailed && (
            <div className="px-3.5 py-1.5 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
              <AlertCircle className="h-3.5 w-3.5" />
              <span className="text-[11px] font-bold uppercase tracking-wider">Retries exhausted</span>
            </div>
          )}
          {(isComplete || completedPages > 0) && (
            <button
              onClick={onViewReport}
              className={`${isComplete ? "bg-emerald-600 hover:bg-emerald-700" : "bg-stone-900 hover:bg-stone-800"} text-white text-xs font-bold px-4 py-2 rounded-lg flex items-center gap-1.5 transition-all shadow-xs active:scale-[0.98]`}
            >
              <span className="tracking-wider uppercase">{isComplete ? "View Report" : "Live Findings"}</span>
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Main Analysis Dashboard Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch shrink-0 relative">
        
        {status === "context_approval" && (
          <div className="absolute inset-0 z-50 bg-white/60 backdrop-blur-md rounded-2xl border border-white/40 shadow-2xl flex flex-col items-center justify-center p-8 text-center animate-in fade-in duration-500">
            <div className="w-16 h-16 bg-gradient-to-br from-brand-400 to-brand-600 rounded-2xl flex items-center justify-center shadow-lg shadow-brand-500/20 mb-6 relative">
              <Sparkles className="h-8 w-8 text-white relative z-10" />
              <div className="absolute inset-0 bg-brand-400 blur-xl opacity-40 animate-pulse" />
            </div>
            <h2 className="text-2xl font-black text-slate-900 tracking-tight mb-2">Context Ready for Approval</h2>
            <p className="text-sm font-medium text-slate-500 max-w-md mb-8 leading-relaxed">
              The AI has extracted and compiled the deep chapter memories for your document. Please review and approve the context so the final proofreading analysis can begin.
            </p>
            <button
              onClick={onReviewContext}
              className="px-6 py-3 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl flex items-center gap-2 shadow-lg transition-transform hover:scale-105 active:scale-95"
            >
              <Eye className="h-4 w-4" />
              Review Chapter Context
            </button>
          </div>
        )}

        {/* Left Column: Execution Timeline Steps */}
        <div className={`lg:col-span-7 bg-white border border-slate-200/80 p-5 rounded-2xl flex flex-col justify-between shadow-[0_4px_24px_rgba(0,0,0,0.03)] relative overflow-hidden ${status === "context_approval" ? "opacity-20 pointer-events-none" : ""}`}>
          <div className="flex items-center justify-between pb-3.5 border-b border-slate-100 shrink-0">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-brand-500" />
              <h3 className="text-xs font-black uppercase tracking-widest text-slate-700">Execution Pipeline Telemetry</h3>
            </div>
            <span className="text-[9.5px] font-mono font-bold text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
              {dynamicSteps.filter((_, idx) => progress >= (idx + 1) * stepWeight).length} / {numSteps} STEPS
            </span>
          </div>
          
          <div className="relative space-y-6 my-4 pl-2 flex-1 flex flex-col justify-center">
            {dynamicSteps.map((step, idx) => {
              const startPct = idx * stepWeight;
              const endPct = (idx + 1) * stepWeight;
              
              const isCompleted = progress >= endPct;
              const isRunning = progress >= startPct && progress < endPct;
              const isQueued = progress < startPct;
              const isLast = idx === numSteps - 1;
              const IconComp = step.icon;

              return (
                <div key={step.id} className="flex items-start gap-4 relative group">
                  {!isLast && (
                    <div 
                      className={`absolute left-[15px] top-8 bottom-[-24px] w-[2px] transition-all duration-500 ${
                        isCompleted ? "bg-emerald-500" : isRunning ? "bg-gradient-to-b from-emerald-500 to-slate-200" : "bg-slate-100"
                      }`} 
                    />
                  )}
                  <div className="z-10 shrink-0 relative mt-0.5">
                    {isCompleted ? (
                      <div className="w-8 h-8 rounded-xl bg-emerald-500 text-white flex items-center justify-center shadow-md shadow-emerald-500/20">
                        <CheckCircle2 className="h-4 w-4" />
                      </div>
                    ) : isRunning ? (
                      <div className="w-8 h-8 rounded-xl bg-brand-50 border-2 border-brand-500 text-brand-600 flex items-center justify-center shadow-md shadow-brand-500/20 relative">
                        <span className="w-2 h-2 rounded-full bg-brand-500 animate-ping absolute" />
                        <IconComp className="h-4 w-4 text-brand-600 relative z-10" />
                      </div>
                    ) : (
                      <div className="w-8 h-8 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-center text-slate-400">
                        <IconComp className="h-4 w-4 opacity-50" />
                      </div>
                    )}
                  </div>
                  
                  <div className="flex-1 min-w-0 bg-slate-50/50 p-3 rounded-xl border border-slate-100 group-hover:border-slate-200/80 transition-all">
                    <div className="flex justify-between items-center mb-1">
                      <div className="flex items-center gap-2">
                        <h4 className={`text-xs font-bold ${isQueued ? "text-slate-400" : "text-slate-800"}`}>
                          {step.title}
                        </h4>
                        <span className="text-[9px] font-mono text-slate-400 hidden sm:inline-block">({step.metric})</span>
                      </div>
                      <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md ${
                        isCompleted ? "bg-emerald-50 text-emerald-700 border border-emerald-200/80" : 
                        isRunning ? "bg-brand-50 text-brand-700 border border-brand-200/80 animate-pulse" : "bg-slate-100 text-slate-400 border border-slate-200/60"
                      }`}>
                        {isCompleted ? "Completed" : isRunning ? "Processing" : "Queued"}
                      </span>
                    </div>
                    
                    {isRunning && (
                      <div className="w-full h-1.5 bg-slate-200/80 rounded-full overflow-hidden my-2 border border-slate-200/50">
                        <div 
                          className="h-full bg-gradient-to-r from-brand-500 to-brand-600 transition-all duration-500 ease-out" 
                          style={{ width: `${Math.min(100, Math.max(0, ((progress - startPct) / stepWeight) * 100))}%` }}
                        />
                      </div>
                    )}
                    
                    <p className={`text-[11px] leading-relaxed font-medium ${
                      isQueued ? "text-slate-400" : isRunning ? "text-slate-700 font-semibold" : "text-slate-500"
                    }`}>
                      {isCompleted ? step.info : step.desc}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-[10px] font-mono text-slate-400 shrink-0">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" /> Sandboxed Execution Environment
            </span>
            <span className="flex items-center gap-1">
              <Zap className="h-3.5 w-3.5 text-brand-500" /> {isPaused ? "Queue paused safely" : "Global AI concurrency protected"}
            </span>
          </div>
        </div>

        {/* Right Column: Circular Progress Gauge & Controls */}
        <div className="lg:col-span-5 space-y-4 flex flex-col justify-between">
          
          {/* Circular SVG Gauge Display */}
          <div className="bg-white border border-slate-200/80 p-6 rounded-2xl flex flex-col items-center justify-center relative overflow-hidden flex-1 shadow-[0_4px_24px_rgba(0,0,0,0.03)]">
            <div className="relative w-40 h-40 mb-3">
              <svg className="w-full h-full transform -rotate-90">
                <defs>
                  <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#f97316" />
                    <stop offset="100%" stopColor="#ea580c" />
                  </linearGradient>
                </defs>
                <circle cx="80" cy="80" r={radius} fill="transparent" stroke="#f1f5f9" strokeWidth="10" />
                <circle
                  cx="80" cy="80" r={radius} fill="transparent" stroke="url(#gaugeGradient)" strokeWidth="10" strokeLinecap="round"
                  strokeDasharray={circ} strokeDashoffset={strokeDashoffset}
                  className="transition-all duration-500 ease-out"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-3xl font-black text-slate-900 font-mono tracking-tight">{progress}%</span>
                <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mt-0.5">Parsed</span>
              </div>
            </div>

            {/* Metric counters grid */}
            <div className="grid grid-cols-2 gap-3 w-full border-t border-slate-100 pt-4 mt-2">
              <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-150 text-center">
                <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider">Est. Remaining</p>
                <p className="text-sm font-black text-slate-800 mt-0.5 font-mono">{eta === 0 ? "READY" : `${eta}s`}</p>
              </div>
              <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-150 text-center">
                <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider">Indexed Pages</p>
                <p className="text-sm font-black text-brand-600 mt-0.5 font-mono">
                  {totalPages > 0 ? `${completedPages} / ${totalPages}` : "--"}
                </p>
              </div>
            </div>
          </div>

          {/* Document File Card & Execution Action Buttons */}
          <div className="bg-white border border-slate-200/80 p-4 rounded-2xl space-y-3.5 shadow-[0_4px_24px_rgba(0,0,0,0.03)] shrink-0">
            <div className="flex items-center gap-3 p-3 bg-slate-50 border border-slate-200/80 rounded-xl">
              <div className="w-10 h-10 flex items-center justify-center bg-white border border-slate-200 text-brand-500 rounded-lg shrink-0 shadow-xs">
                <FileText className="h-5 w-5" />
              </div>
              <div className="overflow-hidden flex-1 min-w-0">
                <p className="text-xs font-bold text-slate-900 truncate">{fileName}</p>
                <p className="text-[9.5px] font-mono font-bold text-slate-400 uppercase mt-0.5">{fileSize} • Upload Ingested</p>
              </div>
            </div>

            <div className="flex gap-2.5">
              <button
                onClick={onPauseToggle}
                className="flex-1 py-2.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-800 font-bold text-xs rounded-xl transition-all flex items-center justify-center gap-2 shadow-xs active:scale-[0.98]"
              >
                {isPaused || hasFailed ? <Play className="h-3.5 w-3.5 fill-current text-slate-600" /> : <Pause className="h-3.5 w-3.5 fill-current text-slate-600" />}
                <span>{hasFailed ? "Retry Failed Pages" : isPaused ? "Resume Parsing" : "Pause Process"}</span>
              </button>
              <button
                onClick={onCancel}
                className="py-2.5 px-4 bg-red-50 hover:bg-red-100 border border-red-200/80 text-red-700 font-bold text-xs rounded-xl transition-all active:scale-[0.98]"
              >
                Abort
              </button>
            </div>
          </div>
          
        </div>
      </div>
    </div>
  );
}
