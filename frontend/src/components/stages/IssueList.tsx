import React from "react";
import { Check, RotateCcw, X } from "lucide-react";
import { ProofreaderIssue } from "@/types/proofreader";

// Same colors and labels from old architecture
const TYPE_COLOR: Record<string, string> = {
  "grammar": "#c93428",
  "spelling": "#c93428",
  "punctuation": "#c93428",
  "factual": "#eab308",
  "formatting": "#3b82f6",
  "flow": "#22c55e",
  "learning_outcomes": "#8b5cf6",
  "image": "#ec4899",
  "examples": "#14b8a6",
};

const TYPE_LABEL: Record<string, string> = {
  "grammar": "Grammar",
  "spelling": "Spelling",
  "punctuation": "Punctuation",
  "factual": "Factual",
  "formatting": "Formatting",
  "flow": "Flow",
  "learning_outcomes": "Learning Outcomes",
  "image": "Image",
  "examples": "Examples",
};

function getRuleTag(issue: ProofreaderIssue) {
  const exp = (issue.explanation || "").toLowerCase();
  const quote = (issue.originalText || "").toLowerCase();
  if (exp.includes("space before the colon") || quote.includes(":-") || (quote.includes(":") && exp.includes("heading"))) {
    return "Heading Colon Rule";
  }
  if (exp.includes("colon before") || (quote.includes(":") && exp.includes("conjunction"))) {
    return "Conjunction Colon Rule";
  }
  if (issue.type === "page_number" || exp.includes("page number")) {
    return "Sequence Check";
  }
  if (issue.category === "Formatting" && exp.includes("alignment")) {
    return "Alignment Check";
  }
  if (issue.type === "flow") {
    return "Sentence Flow";
  }
  return null;
}

interface IssueListProps {
  issues: ProofreaderIssue[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onStatus: (id: number, status: "accepted" | "dismissed" | "open") => void;
  cardRefs: React.MutableRefObject<Record<number, HTMLElement | null>>;
}

export default function IssueList({
  issues,
  selectedId,
  onSelect,
  onStatus,
  cardRefs,
}: IssueListProps) {
  if (!issues.length) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white/60 p-6 text-sm text-slate-500 text-center m-4 shadow-sm">
        No findings are currently recorded. Check the analysis status before treating the document as reviewed.
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4">
      {issues.map((issue, idx) => {
        const active = issue.id === selectedId;
        const color = TYPE_COLOR[issue.type.toLowerCase()] || TYPE_COLOR[issue.category.toLowerCase()] || "#c93428";
        const ruleTag = getRuleTag(issue);
        const pendingVerification = !["pdf_text", "ocr_text"].includes(issue.bboxSource || "") &&
          ["spelling", "grammar", "punctuation", "typography", "heading", "wording"].includes(issue.type);
        
        // Determine status from the new schema
        const status = issue.resolved ? "accepted" : (issue.ignored ? "dismissed" : "open");

        return (
          <article
            key={issue.id}
            id={`sidebar-issue-${issue.id}`}
            ref={(el) => {
              if (cardRefs) cardRefs.current[issue.id] = el;
            }}
            onClick={() => onSelect(issue.id)}
            className={`min-w-0 overflow-hidden cursor-pointer rounded-2xl border bg-white p-3.5 transition-all duration-300 ${
              active ? "border-brand-500 shadow-md ring-1 ring-brand-500/30" : "border-slate-200 hover:border-slate-300"
            } ${status !== "open" ? "opacity-60 grayscale-[0.3]" : ""}`}
          >
            <div className="flex items-start gap-2.5">
              <span
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white shadow-sm"
                style={{ background: color }}
              >
                {idx + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider">
                  <span
                    className="rounded px-1.5 py-0.5"
                    style={{ color, backgroundColor: `${color}15` }}
                  >
                    {TYPE_LABEL[issue.type.toLowerCase()] || issue.type}
                  </span>
                  {ruleTag && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
                      {ruleTag}
                    </span>
                  )}
                  <span
                    className={`ml-auto ${
                      issue.severity === "critical"
                        ? "text-red-500"
                        : issue.severity === "high" || issue.severity === "medium"
                          ? "text-amber-500"
                          : "text-blue-500"
                    }`}
                  >
                    {issue.severity}
                  </span>
                  {status !== "open" && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-400">
                      {status === "accepted" ? "RESOLVED" : "IGNORED"}
                    </span>
                  )}
                </div>

                <p className="mt-2 font-medium leading-5 text-slate-800 text-xs break-words">
                  {issue.originalText || "Visual/Layout Issue"}
                </p>
                {issue.seenInLatestAnalysis === false && (
                  <p className="mt-1 text-[10px] text-amber-700">Retained from an earlier analysis. Review this finding before dismissing it.</p>
                )}
                {!issue.bbox && (
                  <p className="mt-1 text-[10px] text-slate-500">{pendingVerification ? "Unverified candidate. Confirm the printed text before treating this as an error." : "Location could not be verified on the page."}</p>
                )}

                {issue.suggestedText && (
                  <div className="mt-2 flex items-start gap-1 text-xs text-emerald-600">
                    <span className="font-bold text-emerald-700/60 mt-0.5">Fix:</span>
                    <span className="min-w-0 font-mono font-medium rounded bg-emerald-50 border border-emerald-100/50 px-1.5 py-0.5 break-words max-w-[85%]">
                      {issue.suggestedText}
                    </span>
                  </div>
                )}

                {issue.explanation && (
                  <p className="mt-2 text-xs leading-relaxed text-slate-500 break-words">{issue.explanation}</p>
                )}
              </div>
            </div>

            {active && (
              <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 pl-8 animate-in fade-in duration-200">
                <div className="flex gap-2">
                  {!pendingVerification && <Mini
                    onClick={() => onStatus(issue.id, "accepted")}
                    className="text-emerald-600 hover:bg-emerald-50 border border-transparent hover:border-emerald-100"
                    icon={<Check size={13} />}
                    label="Accept Fix"
                  />}
                  <Mini
                    onClick={() => onStatus(issue.id, "dismissed")}
                    className="text-slate-500 hover:bg-slate-100 border border-transparent hover:border-slate-200"
                    icon={<X size={13} />}
                    label="Ignore"
                  />
                  {status !== "open" && (
                    <Mini
                      onClick={() => onStatus(issue.id, "open")}
                      className="text-slate-400 hover:bg-slate-100 border border-transparent hover:border-slate-200"
                      icon={<RotateCcw size={13} />}
                      label="Reset"
                    />
                  )}
                </div>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function Mini({ onClick, className, icon, label }: { onClick: () => void; className: string; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-all ${className}`}
    >
      {icon}
      {label}
    </button>
  );
}
