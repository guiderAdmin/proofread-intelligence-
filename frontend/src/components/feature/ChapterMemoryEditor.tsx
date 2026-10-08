import React, { useState, useEffect } from "react";
import { X, Save, Edit3, Loader2 } from "lucide-react";
import { motion } from "framer-motion";

interface ChapterMemoryEditorProps {
  bookId: string;
  onClose: () => void;
  onApprove?: () => void;
}

export function ChapterMemoryEditor({ bookId, onClose, onApprove }: ChapterMemoryEditorProps) {
  const [chapters, setChapters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const hasPending = chapters.some((c: any) => c.status === "pending" || c.status === "processing");

  const fetchChapters = React.useCallback(async (isPoll = false) => {
    if (!isPoll) setLoading(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/books/${bookId}/chapters`);
      const data = await res.json();
      if (data.chapters) {
        setChapters(data.chapters);
        return data.chapters;
      }
    } catch (err) {
      console.error(err);
    } finally {
      if (!isPoll) setLoading(false);
    }
    return null;
  }, [bookId]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    
    const poll = async () => {
      const currentChapters = await fetchChapters(timeout !== undefined);
      if (currentChapters) {
        const hasPending = currentChapters.some((c: any) => c.status === "pending" || c.status === "processing");
        if (hasPending) {
          timeout = setTimeout(poll, 3000);
        }
      }
    };
    
    poll();
    return () => clearTimeout(timeout);
  }, [bookId, fetchChapters]);

  const startEdit = (chapter: any) => {
    setEditingKey(chapter.chapterKey);
    setEditContent(chapter.customContextOverride || chapter.compactContext || "");
  };

  const saveEdit = async (chapterKey: string) => {
    setSaving(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/books/${bookId}/chapters/${chapterKey}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customContextOverride: editContent }),
      });
      if (res.ok) {
        await fetchChapters();
        setEditingKey(null);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden border border-slate-200"
      >
        <div className="flex items-center justify-between p-5 border-b border-slate-100 bg-slate-50">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Chapter Memory Editor</h2>
            <p className="text-xs text-slate-500 mt-1">Review and edit the context injected into the AI for each chapter.</p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:bg-slate-200 rounded-lg transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6 custom-scrollbar bg-slate-50/50">
          {loading ? (
            <div className="flex justify-center items-center h-32">
              <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
            </div>
          ) : chapters.length === 0 ? (
            <div className="text-center text-slate-500 py-10">No chapter memories built yet.</div>
          ) : (
            chapters.map((chapter) => (
              <div key={chapter.chapterKey} className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                <div className="bg-slate-100/80 px-4 py-3 border-b border-slate-200 flex justify-between items-center">
                  <div>
                    <h3 className="text-sm font-bold text-slate-800">{chapter.title || "Untitled Chapter"}</h3>
                    <p className="text-[10px] text-slate-500">Pages {chapter.startPage} - {chapter.endPage}</p>
                  </div>
                  {editingKey !== chapter.chapterKey && chapter.status !== "pending" && chapter.status !== "processing" && (
                    <button
                      onClick={() => startEdit(chapter)}
                      className="text-xs font-semibold text-brand-600 bg-brand-50 hover:bg-brand-100 px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors"
                    >
                      <Edit3 className="h-3 w-3" />
                      Edit Context
                    </button>
                  )}
                </div>

                <div className="p-4">
                  {editingKey === chapter.chapterKey ? (
                    <div className="space-y-3">
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="w-full h-48 text-xs font-mono p-3 bg-slate-900 text-slate-100 rounded-lg outline-none custom-scrollbar"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setEditingKey(null)}
                          className="px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => saveEdit(chapter.chapterKey)}
                          disabled={saving}
                          className="px-4 py-2 text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors flex items-center gap-2"
                        >
                          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                          Save Context
                        </button>
                      </div>
                    </div>
                  ) : chapter.status === "pending" || chapter.status === "processing" ? (
                    <div className="flex flex-col items-center justify-center p-6 bg-slate-50 rounded-lg border border-slate-100">
                      <Loader2 className="h-6 w-6 text-brand-500 animate-spin mb-2" />
                      <p className="text-xs text-slate-500 font-medium">AI is analyzing this chapter...</p>
                    </div>
                  ) : (
                    <div className="text-xs text-slate-600 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto custom-scrollbar p-3 bg-slate-50 rounded-lg border border-slate-100">
                      {chapter.customContextOverride || chapter.compactContext || "No context generated."}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
        
        <div className="p-4 border-t border-slate-100 bg-white flex justify-between items-center shrink-0">
          <p className="text-xs text-slate-500 max-w-sm">
            Approve this context to let the AI proceed. Any custom edits you saved will be injected exactly as written.
          </p>
          <button
            onClick={async () => {
              try {
                setSaving(true);
                const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/books/${bookId}/chapters`, { method: "POST" });
                if (res.ok) {
                  if (onApprove) onApprove();
                  onClose();
                }
              } catch (e) {
                console.error(e);
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving || chapters.length === 0 || hasPending}
            className={`px-5 py-2.5 text-white text-sm font-bold rounded-xl flex items-center gap-2 shadow-sm transition-colors ${
              hasPending ? "bg-slate-400 cursor-not-allowed" : "bg-emerald-600 hover:bg-emerald-700"
            }`}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {hasPending ? "Building Contexts..." : "Approve & Resume Analysis"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
