"use client";

import React, { useState } from "react";
import { CheckCircle2, FileText, Sparkles, FileCode, Download, RefreshCw, Layers, Award, ArrowRight } from "lucide-react";

interface ExportStageProps {
  onResetSession: () => void;
  onExport: (format: "json" | "csv" | "pdf") => void;
  fileName?: string;
  fileSize?: string | number;
  totalAnnotations?: number;
  hasActiveFile?: boolean;
}

export function ExportStage({
  onResetSession,
  onExport,
  fileName = "document.pdf",
  fileSize = "0.0 MB",
  totalAnnotations = 0,
  hasActiveFile = false,
}: ExportStageProps) {
  const [downloading, setDownloading] = useState<string | null>(null);

  let formattedSize = "Unknown Size";
  if (typeof fileSize === "number") {
    formattedSize = (fileSize / (1024 * 1024)).toFixed(1) + " MB";
  } else if (fileSize) {
    formattedSize = fileSize;
  }

  const handleDownload = async (id: string) => {
    setDownloading(id);
    try {
      await onExport(id as any);
    } catch (e: any) {
      console.warn("Export failed:", e.message);
    }
    setTimeout(() => setDownloading(null), 1000);
  };

  return (
    <div className="flex-grow flex flex-col justify-start w-full space-y-6 relative z-10 font-sans min-h-0 overflow-y-auto custom-scrollbar pr-0.5 pb-2">
      
      {/* Title & Celebration Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-200/60 shrink-0">
        <div>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-emerald-50 text-emerald-700 text-[10px] font-bold uppercase tracking-wider rounded-md border border-emerald-200/60 mb-1">
            <Sparkles className="h-3 w-3" />
            <span>Audit Success</span>
          </div>
          <h2 className="text-xl font-extrabold text-slate-900 tracking-tight leading-tight">Review Session Finalized</h2>
          <p className="text-xs text-slate-500 mt-0.5">All flags resolved. Export the compliancy artifacts below.</p>
        </div>
        <div className="flex items-center gap-3 shrink-0 self-start md:self-auto">
          <div className="w-10 h-10 bg-emerald-50 border border-emerald-200/60 rounded-xl flex items-center justify-center text-emerald-600 shadow-sm">
            <CheckCircle2 className="h-5 w-5" />
          </div>
        </div>
      </div>

      {/* Main Bento Grid Layout */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-stretch w-full">
        
        {/* Left Column: Export Formats */}
        <div className="md:col-span-7 bg-white border border-slate-200/60 p-6 rounded-xl flex flex-col justify-between shadow-[0_8px_30px_rgb(0,0,0,0.01)] min-h-[340px]">
          <div className="space-y-4 flex flex-col items-center justify-center flex-grow">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 border-b border-slate-100 pb-3 w-full self-start">Available Export channels</h3>
            
            <div className="flex-1 flex flex-col items-center justify-center p-8 bg-slate-50/50 border border-slate-200/80 rounded-2xl text-center space-y-5 max-w-md mx-auto w-full">
              <div className="w-14 h-14 rounded-2xl bg-red-50 border border-red-200/60 text-red-650 flex items-center justify-center shadow-2xs">
                <FileText className="h-7 w-7" />
              </div>
              <div>
                <h4 className="text-xs font-extrabold text-slate-800 uppercase tracking-wide">Annotated PDF Document</h4>
                <p className="text-[11px] text-slate-500 mt-1 max-w-xs leading-relaxed font-medium">
                  Original PDF with AI and manual highlights embedded.
                </p>
              </div>

              {hasActiveFile ? (
                <div className="w-full space-y-1 bg-white border border-slate-200 p-3 rounded-xl shadow-2xs text-left">
                  <div className="flex justify-between items-center text-[9px] font-extrabold text-slate-400 uppercase tracking-wide">
                    <span>File Details</span>
                    <span className="bg-slate-50 px-1.5 py-0.5 rounded text-slate-600 font-mono text-[9px] border border-slate-200/60">{formattedSize}</span>
                  </div>
                  <p className="text-xs font-bold text-slate-700 truncate mt-1">{fileName}</p>
                </div>
              ) : (
                <div className="w-full p-3 bg-amber-50/80 border border-amber-200/60 text-amber-800 rounded-xl text-[10px] font-semibold leading-relaxed">
                  No PDF uploaded — export will produce an annotation-only report.
                </div>
              )}

              <button
                onClick={() => handleDownload("pdf")}
                disabled={downloading !== null}
                className="w-full py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-extrabold shadow-md hover:shadow-lg flex items-center justify-center gap-2 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none active:scale-[0.98] text-xs uppercase tracking-wider"
              >
                {downloading === "pdf" ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                <span>Export Annotated PDF</span>
              </button>
            </div>
          </div>

          {/* Secure sandbox message */}
          <div className="mt-6 bg-emerald-50/40 border border-emerald-100/60 rounded-xl p-4 flex items-start gap-3 w-full">
            <div className="w-8 h-8 rounded-lg bg-white border border-emerald-200 flex items-center justify-center shrink-0 text-emerald-600 shadow-sm">
              <CheckCircle2 className="h-4 w-4" />
            </div>
            <div>
              <p className="text-[10px] font-bold text-emerald-800 uppercase tracking-widest">In-Memory Security Standard</p>
              <p className="text-[11px] text-emerald-700/80 mt-1 leading-relaxed font-medium">
                No external DB dependencies. Data persists inside transient state and parses safely.
              </p>
            </div>
          </div>
        </div>

        {/* Right Column: Processing Stats */}
        <div className="md:col-span-5 bg-white border border-slate-200/60 p-6 rounded-xl flex flex-col justify-between shadow-[0_8px_30px_rgb(0,0,0,0.01)] min-h-[340px]">
          <div className="space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 border-b border-slate-100 pb-3">Session Audit Details</h3>
            
            <div className="space-y-3 pt-1">
              <div className="flex items-center gap-3.5 p-3 rounded-lg bg-slate-50 border border-slate-200">
                <div className="w-10 h-10 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center border border-brand-200 shrink-0">
                  <Award className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <span className="text-[9px] text-slate-400 uppercase font-bold tracking-wider">Rating</span>
                  <p className="text-xs font-bold text-slate-800 mt-0.5">Compliancy Met (Grade A)</p>
                </div>
              </div>

              <div className="flex items-center gap-3.5 p-3 rounded-lg bg-slate-50 border border-slate-200">
                <div className="w-10 h-10 rounded-lg bg-accent-50 text-accent-600 flex items-center justify-center border border-accent-200 shrink-0">
                  <Layers className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <span className="text-[9px] text-slate-400 uppercase font-bold tracking-wider">Resolution</span>
                  <p className="text-xs font-bold text-slate-800 mt-0.5">{totalAnnotations} total items verified</p>
                </div>
              </div>


            </div>
          </div>

          <div className="pt-6 border-t border-slate-100 text-center mt-6">
            <button
              onClick={onResetSession}
              className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-3 px-4 rounded-lg flex items-center justify-center gap-1.5 transition-all shadow-sm active:scale-[0.98] uppercase tracking-wider text-xs"
            >
              <span>Restart Session</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
