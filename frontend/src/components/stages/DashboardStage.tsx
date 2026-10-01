"use client";

import React from "react";
import { ArrowRight, ChevronRight, Sparkles, AlertTriangle, ShieldCheck, FileSearch, Database, CheckCircle2 } from "lucide-react";
import { ProofreaderResponse } from "@/types/proofreader";

interface DashboardStageProps {
  data: ProofreaderResponse | null;
  onReviewIssue: (issueId: number) => void;
  onLaunchReview: () => void;
  onExport: (format: "json" | "csv") => void;
  selectedFile?: any;
}

export function DashboardStage({ data, onReviewIssue, onLaunchReview, onExport, selectedFile }: DashboardStageProps) {
  const issues = data?.issues || [];

  const getCategoryMetrics = () => {
    let grammarCount = 0;
    let pedagogyCount = 0;
    let factCount = 0;
    let styleCount = 0;

    issues.forEach(issue => {
      if (issue.resolved || issue.ignored) return;
      const cat = (issue.category || "").toLowerCase();
      if (cat.includes("grammar") || cat.includes("spell") || cat.includes("syntax")) grammarCount++;
      else if (cat.includes("format") || cat.includes("layout") || cat.includes("pedagog") || cat.includes("structure")) pedagogyCount++;
      else if (cat.includes("fact") || cat.includes("accura")) factCount++;
      else styleCount++;
    });

    const calc = (count: number) => Math.max(0, 100 - (count * 4));
    
    return [
      { 
        label: "Syntax Health", score: calc(grammarCount), 
        status: grammarCount === 0 ? "Verified" : `${grammarCount} Alert${grammarCount > 1 ? "s" : ""}`, 
        icon: FileSearch, color: "text-brand-600", bg: "bg-brand-50 border-brand-100",
        barColor: "bg-brand-500"
      },
      { 
        label: "Curriculum Alignment", score: calc(pedagogyCount), 
        status: pedagogyCount === 0 ? "Compliant" : `${pedagogyCount} Alert${pedagogyCount > 1 ? "s" : ""}`, 
        icon: ShieldCheck, color: "text-blue-600", bg: "bg-blue-50 border-blue-100",
        barColor: "bg-blue-500"
      },
      { 
        label: "Fact Accuracy", score: calc(factCount), 
        status: factCount === 0 ? "Verified" : `${factCount} Alert${factCount > 1 ? "s" : ""}`, 
        icon: Database, color: "text-emerald-600", bg: "bg-emerald-50 border-emerald-100",
        barColor: "bg-emerald-500"
      },
      { 
        label: "Style & Consistency", score: calc(styleCount), 
        status: styleCount === 0 ? "Consistent" : `${styleCount} Alert${styleCount > 1 ? "s" : ""}`, 
        icon: AlertTriangle, color: "text-amber-600", bg: "bg-amber-50 border-amber-100",
        barColor: "bg-amber-500"
      },
    ];
  };

  const metrics = getCategoryMetrics();

  // Dynamic insights parsed from the persisted page analysis.
  const subjectText = selectedFile?.subject && selectedFile.subject !== "Auto-detected by AI"
    ? selectedFile.subject
    : Array.from(new Set((data?.perPage || []).map((p: any) => p.subjectKey).filter(Boolean))).join(', ') || "GENERAL";

  const totalPagesScanned = data?.pagesReviewed || data?.pagesExpected || 0;
  const pendingVisualsCount = data?.visualReviewPendingCount ?? 0;

  return (
    <div className="flex-1 flex flex-col justify-start w-full space-y-5 relative z-10 font-sans min-h-0 overflow-y-auto custom-scrollbar pr-0.5 pb-2">
      
      {/* Title & Headline Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-slate-200/60 shrink-0">
        <div>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-brand-50 text-brand-700 text-[10px] font-bold uppercase tracking-wider rounded-md border border-brand-100/80 mb-1 shadow-xs">
            <Sparkles className="h-3 w-3 text-brand-600" />
            <span>Diagnostic Audit Scorecard</span>
          </div>
          <h2 className="text-xl font-extrabold text-slate-900 tracking-tight leading-tight">Curriculum Intelligence Report</h2>
          <p className="text-xs text-slate-500 mt-0.5 font-medium">Automated validation scorecard compiled from saved page-level evidence.</p>
        </div>
        <div className="flex items-center gap-3 shrink-0 self-start md:self-auto">
          <button
            onClick={onLaunchReview}
            className="bg-slate-900 hover:bg-brand-600 text-white font-bold px-4 py-2 rounded-lg flex items-center gap-2 transition-all shadow-md shadow-slate-900/10 active:scale-[0.98] text-xs uppercase tracking-wider group"
          >
            <span>Launch Canvas Review</span>
            <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
          </button>
        </div>
      </div>

      {/* Metric Score Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 shrink-0">
        {metrics.map((card) => (
          <div 
            key={card.label} 
            className="bg-white p-4 rounded-xl border border-slate-200/70 shadow-[0_4px_20px_rgb(0,0,0,0.02)] hover:shadow-md hover:border-slate-300 transition-all group"
          >
            <div className="flex items-center justify-between mb-3">
              <div className={`p-2 rounded-lg border ${card.bg} ${card.color}`}>
                <card.icon className="h-4.5 w-4.5" />
              </div>
              <span className={`text-[9.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md border ${
                card.score === 100 
                  ? "bg-emerald-50/80 text-emerald-700 border-emerald-200/80" 
                  : "bg-amber-50/80 text-amber-700 border-amber-200/80"
              }`}>
                {card.status}
              </span>
            </div>
            
            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">{card.label}</p>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-2xl font-black text-slate-900 font-mono tracking-tighter">{card.score}</span>
              <span className="text-xs text-slate-400 font-bold">/100</span>
            </div>

            {/* Score Progress Bar */}
            <div className="w-full bg-slate-100 h-1.5 rounded-full mt-3 overflow-hidden">
              <div 
                className={`h-full rounded-full transition-all duration-500 ${card.barColor}`} 
                style={{ width: `${card.score}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Main Content Area: Table & AI Insights */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch shrink-0">
        
        {/* Identified Anomalies Table Card */}
        <div className="lg:col-span-8 bg-white border border-slate-200/70 shadow-[0_4px_20px_rgb(0,0,0,0.02)] rounded-xl flex flex-col overflow-hidden h-[330px]">
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/40 flex justify-between items-center shrink-0">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-brand-500" />
              <span>Identified Anomalies</span>
            </h3>
            <span className="px-2.5 py-0.5 bg-white border border-slate-200 text-slate-700 rounded-md text-[10px] font-bold font-mono shadow-2xs">
              {issues.length} alert{issues.length !== 1 ? "s" : ""}
            </span>
          </div>
          
          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100 text-[9.5px] text-slate-400 font-bold uppercase bg-white sticky top-0 z-10 shadow-2xs">
                  <th className="px-5 py-2.5 bg-white">Severity</th>
                  <th className="px-5 py-2.5 bg-white">Issue Type</th>
                  <th className="px-5 py-2.5 bg-white">Page</th>
                  <th className="px-5 py-2.5 text-right bg-white">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {issues.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-12 text-center">
                      <div className="flex flex-col items-center justify-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-100 flex items-center justify-center shadow-xs">
                          <CheckCircle2 className="h-5 w-5" />
                        </div>
                        <div>
                          <p className="font-bold text-slate-800 text-xs">Perfect Compliance</p>
                          <p className="text-[11px] font-medium text-slate-400 max-w-xs mx-auto mt-0.5">
                            No critical alerts or pedagogical anomalies were flagged.
                          </p>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  issues.map((issue) => (
                    <tr key={issue.id} className="hover:bg-slate-50/80 transition-colors group">
                      <td className="px-5 py-2.5 font-semibold shrink-0">
                        <span
                          className={`px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider border ${
                            issue.severity === "critical"
                              ? "bg-red-55/80 text-red-700 border-red-200/80 shadow-2xs"
                              : issue.severity === "high"
                              ? "bg-amber-55/80 text-amber-700 border-amber-200/80"
                              : issue.severity === "medium"
                              ? "bg-blue-55/80 text-blue-700 border-blue-200/80"
                              : "bg-slate-50 text-slate-700 border-slate-200"
                          }`}
                        >
                          {issue.severity}
                        </span>
                      </td>
                      <td className="px-5 py-2.5 max-w-md">
                        <p className="font-bold text-slate-800 text-xs">{issue.type}</p>
                        <p className="text-[10.5px] font-medium text-slate-500 mt-0.5 line-clamp-1 leading-normal">
                          &ldquo;{issue.originalText}&rdquo;
                        </p>
                      </td>
                      <td className="px-5 py-2.5 font-mono font-bold text-slate-500 text-[10px] whitespace-nowrap">
                        {issue.locationHint}
                      </td>
                      <td className="px-5 py-2.5 text-right whitespace-nowrap">
                        <button
                          onClick={() => onReviewIssue(issue.id)}
                          className="text-brand-600 hover:text-brand-700 hover:bg-brand-50/80 px-3 py-1 rounded-md transition-all inline-flex items-center gap-1 text-[11px] font-bold border border-transparent hover:border-brand-200 active:scale-[0.98]"
                        >
                          <span>Inspect</span>
                          <ChevronRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Side AI Insights Card */}
        <div className="lg:col-span-4 bg-white border border-slate-200/70 shadow-[0_4px_20px_rgb(0,0,0,0.02)] rounded-xl p-4 flex flex-col justify-between h-[330px]">
          <div className="overflow-hidden flex flex-col min-h-0 flex-1">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 border-b border-slate-100 pb-2 mb-2.5 flex items-center gap-1.5 shrink-0">
              <Sparkles className="h-4 w-4 text-brand-500" />
              <span>AI Insights & Metrics</span>
            </h3>

            <div className="space-y-2 flex-1 overflow-y-auto custom-scrollbar pr-0.5">
              {/* Insight Card 1 */}
              <div className="p-2.5 bg-slate-50/80 rounded-xl border-l-4 border-l-brand-500 border-y border-r border-slate-200/70 hover:bg-white transition-colors">
                <p className="text-[9px] font-bold text-brand-600 uppercase tracking-wider mb-0.5">Target Profile</p>
                <p className="font-bold text-slate-800 text-xs">{subjectText} Standard</p>
                <p className="text-[10px] text-slate-500 mt-0.5 font-medium">Audit rules matched to selected domain.</p>
              </div>

              {/* Insight Card 2 */}
              <div className="p-2.5 bg-slate-50/80 rounded-xl border-l-4 border-l-emerald-500 border-y border-r border-slate-200/70 hover:bg-white transition-colors">
                <p className="text-[9px] font-bold text-emerald-600 uppercase tracking-wider mb-0.5">Audit Coverage</p>
                <p className="font-bold text-slate-800 text-xs">{totalPagesScanned} Pages</p>
                <p className="text-[10px] text-slate-500 mt-0.5 font-medium">100% text layer parsed & validated.</p>
              </div>

              {/* Insight Card 3 */}
              <div className="p-2.5 bg-slate-50/80 rounded-xl border-l-4 border-l-blue-500 border-y border-r border-slate-200/70 hover:bg-white transition-colors">
                <p className="text-[9px] font-bold text-blue-600 uppercase tracking-wider mb-0.5">Visual Reviews</p>
                <p className="font-bold text-slate-800 text-xs">{pendingVisualsCount} Pages Pending</p>
                <p className="text-[10px] text-slate-500 mt-0.5 font-medium">
                  {pendingVisualsCount > 0 ? "Manual visual validation recommended." : "No visual layout issues detected."}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-3 pt-2.5 border-t border-slate-100 shrink-0">
            <button
              onClick={onLaunchReview}
              className="w-full bg-slate-900 hover:bg-brand-600 text-white font-bold py-2 rounded-lg flex items-center justify-center gap-1.5 transition-all active:scale-[0.98] text-xs uppercase tracking-wider shadow-sm group"
            >
              <span>Verification Canvas</span>
              <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
