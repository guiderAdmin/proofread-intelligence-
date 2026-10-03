"use client";
import React, { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { UploadCloud, ChevronRight, File as FileIcon, ChevronDown, FolderOpen, Clock3, ArrowRight, Zap, X, Cpu, Sparkles, Settings, CheckCircle2, Trash2, Bot } from "lucide-react";

interface SavedBookSummary {
  id: string;
  title: string;
  originalName?: string;
  pageCount: number;
  status: "queued" | "processing" | "paused" | "done" | "error";
  progress?: { done?: number; failed?: number };
  stats?: { issues?: number };
  createdAt?: string;
}

interface UploadStageProps {
  selectedFile: {
    name: string;
    subject: string;
    size: string;
    pages: number;
    eta: string;
    rawFile?: File;
  } | null;
  onFileSelect: (file: File) => void;
  onStartAnalysis: (scanTypes: string[], classLevel: string, subject: string, language: string, delaySeconds: number, instructions: string) => void;
  savedBooks?: SavedBookSummary[];
  savedBooksLoading?: boolean;
  onOpenSaved?: (book: SavedBookSummary) => void;
  onDeleteSaved?: (bookId: string) => void;
}

export function UploadStage({ selectedFile, onFileSelect, onStartAnalysis, savedBooks = [], savedBooksLoading = false, onOpenSaved, onDeleteSaved }: UploadStageProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showModal, setShowModal] = useState(false);
  // Keep setupStep for compatibility but modal replaces the inline card
  const [setupStep, setSetupStep] = useState<"projects" | "preferences" | "document">("projects");
  
  const [classLevel, setClassLevel] = useState<string>("");
  const [subject, setSubject] = useState<string>("");
  const [language, setLanguage] = useState<string>("");
  const [delaySeconds, setDelaySeconds] = useState<number>(0);
  const [instructions, setInstructions] = useState<string>("");
  const [fileError, setFileError] = useState<string>("");
  const [isDragOver, setIsDragOver] = useState(false);

  const [bookToDelete, setBookToDelete] = useState<SavedBookSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [openingBookId, setOpeningBookId] = useState<string | null>(null);

  const handleContainerClick = () => {
    fileInputRef.current?.click();
  };

  const acceptFile = (file?: File) => {
    if (!file) return;
    if (file.size === 0) {
      setFileError("This PDF is empty. Choose a file with content.");
      return;
    }
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setFileError("Choose a PDF document.");
      return;
    }
    if (file.size > 250 * 1024 * 1024) {
      setFileError("PDF must be 250 MB or smaller.");
      return;
    }
    setFileError("");
    onFileSelect(file);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    acceptFile(e.target.files?.[0]);
  };

  const canStart = !!classLevel && !!language && !!selectedFile?.rawFile && !fileError;

  const openModal = () => {
    setShowModal(true);
    setSetupStep("preferences");
  };

  const closeModal = () => {
    setShowModal(false);
    setSetupStep("projects");
  };

  return (
    <>
      {/* ─── Projects View (always visible) ─── */}
      <div className="flex-grow flex flex-col justify-start w-full space-y-5 relative z-10 font-sans min-h-0 overflow-y-auto custom-scrollbar pr-0.5 pb-20">
        
        {/* Page Header */}
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-3 pb-3 border-b border-slate-200/80">
          <div>
            <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-orange-200 bg-orange-50/50 mb-1.5">
              <Sparkles className="h-3 w-3 text-orange-600" />
              <span className="text-[9px] font-bold text-orange-600 uppercase tracking-wider">Workspace Management</span>
            </div>
            <h2 className="text-xl font-extrabold text-slate-900 tracking-tight leading-tight">
              Your Projects
            </h2>
            <p className="text-[13px] text-slate-500 mt-0.5 font-medium">
              Start a new project or continue reviewing saved work.
            </p>
          </div>
          <div className="flex items-center gap-2 px-3.5 py-1.5 bg-white/80 backdrop-blur border border-slate-200/80 rounded-full shadow-sm self-start md:self-auto mt-1 md:mt-0">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">AI Engine Ready</span>
          </div>
        </div>

        {/* Premium Hero Banner */}
        <section className="relative overflow-hidden rounded-[24px] shadow-xl shrink-0 border border-brand-200/60 bg-white">
          <div className="absolute inset-0 bg-gradient-to-br from-brand-50 via-white to-brand-100/50" />
          
          {/* Glowing Orbs */}
          <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-brand-400/10 rounded-full blur-[100px] translate-x-1/3 -translate-y-1/4 mix-blend-multiply" />
          <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-blue-400/10 rounded-full blur-[100px] -translate-x-1/4 translate-y-1/3 mix-blend-multiply" />
          
          {/* Subtle grid pattern */}
          <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'linear-gradient(rgba(0,0,0,1) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,1) 1px, transparent 1px)', backgroundSize: '32px 32px' }} />
          
          <div className="relative z-10 p-8 md:p-12 flex flex-col md:flex-row md:items-center justify-between gap-8">
            <div className="space-y-5 min-w-0">
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-brand-100/50 border border-brand-200/60 shadow-sm">
                <Zap className="h-3.5 w-3.5 text-brand-600" />
                <span className="text-[11px] font-bold text-brand-700 uppercase tracking-[0.2em]">Next-Gen Proofreading</span>
              </div>
              
              <h3 className="text-3xl md:text-4xl font-extrabold text-slate-900 tracking-tight leading-[1.15]">
                Elevate your documents <br className="hidden md:block" />
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-600 to-indigo-600">
                  in seconds.
                </span>
              </h3>
              
              <p className="text-slate-600 text-sm md:text-base font-medium max-w-md">
                Upload your PDF and let our AI engine instantly audit for syntax, structure, and curricular consistency.
              </p>
            </div>
            <button
              type="button"
              onClick={openModal}
              className="shrink-0 group relative bg-[#E56844] text-white rounded-full px-8 py-3.5 text-[16px] font-bold flex items-center gap-2.5 transition-all duration-300 shadow-[0_8px_20px_rgba(139,92,246,0.15)] hover:shadow-[0_12px_24px_rgba(139,92,246,0.25)] hover:scale-[1.02] active:scale-[0.98] hover:bg-[#D45936]"
            >
              <span>Start Analysis</span>
              <ArrowRight className="h-5 w-5 group-hover:translate-x-1 transition-transform" strokeWidth={2.5} />
            </button>
          </div>
        </section>

        {/* Feature Highlights */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 shrink-0">
          {[
            { icon: Sparkles, title: "Syntactic Auditing", desc: "Tone, spelling & layout rules", bg: "from-brand-50 to-brand-100/50", border: "border-brand-100", iconColor: "text-brand-600" },
            { icon: Settings, title: "Structure Validator", desc: "Blocks, pages & annotations", bg: "from-blue-50 to-blue-100/50", border: "border-blue-100", iconColor: "text-blue-600" },
            { icon: CheckCircle2, title: "Curricular Consistency", desc: "Content & outcome checks", bg: "from-emerald-50 to-emerald-100/50", border: "border-emerald-100", iconColor: "text-emerald-600" },
          ].map((feat) => (
            <div key={feat.title} className={`flex items-center gap-3.5 p-4 rounded-xl bg-gradient-to-br ${feat.bg} border ${feat.border} shadow-sm`}>
              <div className={`w-10 h-10 rounded-xl bg-white flex items-center justify-center shrink-0 shadow-sm border ${feat.border}`}>
                <feat.icon className={`h-4 w-4 ${feat.iconColor}`} />
              </div>
              <div>
                <p className="text-[13px] font-bold text-slate-800">{feat.title}</p>
                <p className="text-[11px] text-slate-500 mt-0.5">{feat.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Recent Proofreads */}
        <section className="bg-white border border-slate-200/70 rounded-xl shadow-sm overflow-hidden shrink-0">
          <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center">
                <Clock3 className="h-3.5 w-3.5 text-slate-500" />
              </div>
              <h3 className="text-[12px] font-bold uppercase tracking-widest text-slate-600">Recent Proofreads</h3>
            </div>
            <span className="text-[11px] font-mono text-slate-400 bg-slate-50 px-2 py-0.5 rounded-md">{savedBooks.length} saved</span>
          </div>
          {savedBooksLoading ? (
            <div className="px-5 py-8 flex items-center justify-center">
              <div className="flex items-center gap-3 text-sm text-slate-400">
                <div className="w-5 h-5 border-2 border-slate-200 border-t-brand-500 rounded-full animate-spin" />
                Loading saved work…
              </div>
            </div>
          ) : savedBooks.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <FolderOpen className="h-8 w-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-400">Completed and active proofreads will appear here.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {savedBooks.slice(0, 8).map((book) => {
                const complete = Number(book.progress?.done || 0);
                const progress = book.pageCount ? Math.round((complete / book.pageCount) * 100) : 0;
                return (
                  <button 
                    key={book.id} 
                    type="button" 
                    disabled={openingBookId !== null}
                    onClick={async () => {
                      if (openingBookId) return;
                      setOpeningBookId(book.id);
                      try {
                        await onOpenSaved?.(book);
                      } finally {
                        setOpeningBookId(null);
                      }
                    }} 
                    className={`w-full px-5 py-3.5 flex items-center gap-3.5 text-left transition-colors group ${openingBookId === book.id ? 'bg-slate-50 opacity-80' : 'hover:bg-slate-50/80'}`}
                  >
                    <div className="w-10 h-10 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-400 group-hover:text-brand-600 group-hover:border-brand-200 group-hover:bg-brand-50/50 transition-all">
                      {openingBookId === book.id ? (
                        <div className="w-4 h-4 border-2 border-brand-200 border-t-brand-600 rounded-full animate-spin" />
                      ) : (
                        <FolderOpen className="h-4 w-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-slate-800 truncate">
                        {book.title}
                        {openingBookId === book.id && <span className="ml-2 text-[10px] text-brand-500 font-normal">Opening...</span>}
                      </p>
                      <p className="text-[11px] text-slate-400 mt-0.5">{book.pageCount} pages · {book.stats?.issues || 0} findings · {progress}%</p>
                    </div>
                    <span className={`text-[9px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-lg border ${
                      book.status === "done"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : book.status === "error"
                          ? "bg-red-50 text-red-700 border-red-200"
                          : "bg-amber-50 text-amber-700 border-amber-200"
                    }`}>
                      {book.status}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setBookToDelete(book);
                      }}
                      className="ml-2 p-1.5 rounded-md text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                      title="Delete proofread"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    <ChevronRight className="h-4 w-4 ml-1 text-slate-300 group-hover:text-brand-500 transition-colors" />
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* ─── Modal Overlay ─── */}
      {showModal && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          {/* Blurred backdrop */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={closeModal}
          />

          {/* Modal Card */}
          <div
            className="relative z-10 bg-[#faf8f5] border border-stone-200/80 rounded-2xl shadow-2xl p-7 md:p-9 space-y-6 w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto custom-scrollbar animate-in fade-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Card Header */}
            <div className="flex items-center justify-between">
              <h3 className="text-[22px] font-bold text-stone-900 tracking-tight">New proofread</h3>
              <button
                type="button"
                onClick={closeModal}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-stone-400 hover:text-stone-700 hover:bg-stone-200/60 transition-colors"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Hidden file input */}
            <input type="file" accept=".pdf" ref={fileInputRef} onChange={handleFileChange} className="hidden" />

            {/* Dropzone */}
            <div
              onClick={handleContainerClick}
              onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setIsDragOver(false); acceptFile(e.dataTransfer.files?.[0]); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleContainerClick(); } }}
              role="button"
              tabIndex={0}
              aria-label="Choose or drop a PDF document"
              className={`rounded-xl border-2 border-dashed p-8 flex flex-col items-center justify-center gap-3 transition-all duration-200 cursor-pointer group ${
                isDragOver
                  ? "border-brand-400 bg-brand-50/30"
                  : selectedFile
                    ? "border-emerald-300/80 bg-emerald-50/20"
                    : "border-stone-300/80 bg-white/60 hover:border-brand-400/60 hover:bg-white"
              }`}
            >
              {selectedFile ? (
                <div className="text-center">
                  <div className="w-12 h-12 mx-auto mb-3 bg-emerald-50 border border-emerald-200/80 rounded-xl flex items-center justify-center">
                    <FileIcon className="h-5 w-5 text-emerald-600" />
                  </div>
                  <p className="text-sm font-bold text-stone-800 truncate max-w-xs">{selectedFile.name}</p>
                  <p className="text-xs text-stone-400 mt-1 mb-3">{selectedFile.size}</p>
                  <span className="text-xs font-semibold text-stone-500 underline underline-offset-2 decoration-stone-300">Replace file</span>
                </div>
              ) : (
                <div className="text-center">
                  <div className={`w-12 h-12 mx-auto mb-3 rounded-xl border flex items-center justify-center transition-all ${
                    isDragOver
                      ? "bg-brand-500 border-brand-500 text-white"
                      : "bg-white border-stone-200 text-brand-500 group-hover:border-brand-200"
                  }`}>
                    <UploadCloud className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-semibold text-stone-800">
                    {isDragOver ? "Drop your file here" : "Drop or click to choose the designed PDF"}
                  </p>
                  <p className="text-xs text-stone-400 mt-1.5">Up to 250 MB · 120–150 pages is the intended size</p>
                </div>
              )}
            </div>
            {fileError && (
              <p className="text-xs font-semibold text-red-600 -mt-3" role="alert">{fileError}</p>
            )}

            {/* Class Standard (full width) */}
            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wider">Class Standard</label>
              <div className="relative">
                <select
                  aria-label="Class standard"
                  value={classLevel}
                  onChange={(e) => setClassLevel(e.target.value)}
                  className="w-full appearance-none bg-white border border-stone-200 rounded-xl px-4 py-3 text-sm font-medium text-stone-800 focus:outline-none focus:border-stone-400 focus:ring-1 focus:ring-stone-400/20 transition-all cursor-pointer"
                >
                  <option value="">Select Class Standard</option>
                  <option>Nursery / Kindergarten</option>
                  {Array.from({ length: 12 }, (_, index) => <option key={index}>Class {index + 1}</option>)}
                  <option>General audience</option>
                </select>
                <ChevronDown className="h-4 w-4 text-stone-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>

            {/* Language + Subject (2 columns) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wider">Language</label>
                <div className="relative">
                  <select
                    aria-label="Language target"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="w-full appearance-none bg-white border border-stone-200 rounded-xl px-4 py-3 text-sm font-medium text-stone-800 focus:outline-none focus:border-stone-400 focus:ring-1 focus:ring-stone-400/20 transition-all cursor-pointer"
                  >
                    <option value="">Auto / mixed</option>
                    <option>English (Indian / British)</option>
                    <option>English (US)</option>
                    <option>Hindi</option>
                  </select>
                  <ChevronDown className="h-4 w-4 text-stone-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wider">Subject</label>
                <input
                  aria-label="Subject domain"
                  maxLength={100}
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="e.g. Mathematics"
                  className="w-full bg-white border border-stone-200 rounded-xl px-4 py-3 text-sm font-medium text-stone-800 focus:outline-none focus:border-stone-400 focus:ring-1 focus:ring-stone-400/20 transition-all placeholder:text-stone-400"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-[11px] font-bold text-stone-500 uppercase tracking-wider">
                <Bot className="h-3.5 w-3.5 text-brand-500" /> Project assistant instructions
              </label>
              <textarea
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="Optional: Use British English, preserve quotations, check footnote placement…"
                className="w-full resize-none bg-white border border-stone-200 rounded-xl px-4 py-3 text-sm font-medium text-stone-800 focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-300/30 transition-all placeholder:text-stone-400"
              />
              <p className="text-[10px] text-stone-400">Duplicate built-in rules are ignored. These instructions are saved with the project and available to the moving assistant.</p>
            </div>

            {/* Start button */}
            <button
              onClick={() => {
                onStartAnalysis(["grammar", "object", "fact"], classLevel, subject.trim(), language, delaySeconds, instructions.trim());
                closeModal();
              }}
              disabled={!canStart}
              className="w-full bg-stone-900 hover:bg-stone-800 disabled:bg-stone-200 disabled:text-stone-400 text-white font-bold py-3.5 rounded-2xl transition-all duration-200 text-sm tracking-wide active:scale-[0.99] disabled:cursor-not-allowed"
            >
              Start page-by-page analysis
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* ─── Delete Confirmation Modal ─── */}
      {bookToDelete && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={() => !isDeleting && setBookToDelete(null)}
          />
          <div className="relative bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-sm overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-6">
              <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mb-4 text-red-600">
                <Trash2 className="h-6 w-6" />
              </div>
              <h3 className="text-lg font-bold text-slate-900 mb-2">Delete Proofread?</h3>
              <p className="text-sm text-slate-500 mb-6">
                Are you sure you want to delete <span className="font-semibold text-slate-700">{bookToDelete.title}</span>? This action cannot be undone and all data will be permanently lost.
              </p>
              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => setBookToDelete(null)}
                  className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={async () => {
                    setIsDeleting(true);
                    try {
                      await onDeleteSaved?.(bookToDelete.id);
                    } finally {
                      setIsDeleting(false);
                      setBookToDelete(null);
                    }
                  }}
                  className="px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors disabled:opacity-70 flex items-center gap-2"
                >
                  {isDeleting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Deleting...
                    </>
                  ) : "Delete"}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
