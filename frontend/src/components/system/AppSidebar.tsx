"use client";

import React from "react";
import {
  FileText, Settings,
  Hexagon, ChevronLeft, ChevronRight, X
} from "lucide-react";
import { PagesPreview } from "./PagesPreview";
import { ProofreaderIssue } from "@/types/proofreader";

interface AppSidebarProps {
  stage: string;
  setStage: (stage: any) => void;
  isSidebarExpanded: boolean;
  setIsSidebarExpanded: (v: boolean) => void;
  sidebarActiveTab: "proofreading" | "preview" | "settings";
  setSidebarActiveTab: (tab: "proofreading" | "preview" | "settings") => void;
  selectedFile: { name: string; subject: string; size: string; pages: number; eta: string } | null;
  totalPages: number;
  currentPage: number;
  setCurrentPage: (page: number) => void;
  issues: ProofreaderIssue[];
}

export function AppSidebar({
  stage,
  setStage,
  isSidebarExpanded,
  setIsSidebarExpanded,
  sidebarActiveTab,
  setSidebarActiveTab,
  selectedFile,
  totalPages,
  currentPage,
  setCurrentPage,
  issues,
}: AppSidebarProps) {
  return (
    <>
      {/* 1. Leftmost Icon Rail */}
      <div className="w-16 bg-white border-r border-slate-200 flex flex-col justify-between items-center py-6 shadow-sm z-50 shrink-0">
        <div className="flex flex-col gap-5 items-center">
          {/* Logo */}
          <div className="w-10 h-10 mb-2 flex items-center justify-center bg-gradient-to-br from-brand-500 to-brand-600 rounded-lg shadow-sm shadow-brand-500/20 shrink-0">
            <Hexagon className="h-5 w-5 text-white" />
          </div>

          {/* PDF Pages Preview — always visible, opens drawer */}
          <button
            onClick={() => {
              setSidebarActiveTab("preview");
              setIsSidebarExpanded(true);
            }}
            title="PDF Pages Preview"
            className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer ${
              isSidebarExpanded && sidebarActiveTab === "preview"
                ? "bg-brand-50 border border-brand-100 text-brand-600 shadow-sm"
                : "text-slate-400 hover:text-slate-600 hover:bg-slate-50 border border-transparent"
            }`}
          >
            <FileText className="h-4 w-4" />
          </button>

          {/* Settings Tab */}
          <button
            onClick={() => {
              setSidebarActiveTab("settings");
              setIsSidebarExpanded(false);
            }}
            title="Settings"
            className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer ${
              !isSidebarExpanded && sidebarActiveTab === "settings"
                ? "bg-brand-50 border border-brand-100 text-brand-600 shadow-sm"
                : "text-slate-400 hover:text-slate-600 hover:bg-slate-50 border border-transparent"
            }`}
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>

        {/* Chevron Toggle */}
        <button
          onClick={() => {
            setSidebarActiveTab("preview");
            setIsSidebarExpanded(!isSidebarExpanded);
          }}
          title={isSidebarExpanded ? "Collapse Sidebar" : "Expand Sidebar"}
          className="w-10 h-10 rounded-xl bg-slate-50 border border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shadow-sm transition-all duration-200 cursor-pointer"
        >
          {isSidebarExpanded ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </div>

      {/* 2. Collapsible Pages Preview Drawer */}
      <div
        className={`h-full bg-white border-r border-slate-200/60 transition-all duration-300 ease-in-out flex flex-col overflow-hidden z-40 shrink-0 ${
          isSidebarExpanded && sidebarActiveTab === "preview"
            ? "w-64 opacity-100"
            : "w-0 opacity-0 pointer-events-none"
        }`}
      >
        <div className="flex flex-col h-full w-64 shrink-0 overflow-hidden">
          {/* Drawer Header */}
          <div className="px-5 h-16 border-b border-slate-100 flex items-center justify-between shrink-0">
            <h3 className="text-[11px] font-bold text-slate-800 uppercase tracking-wider">
              Pages Preview
            </h3>
            <button
              onClick={() => setIsSidebarExpanded(false)}
              className="w-6 h-6 rounded-md bg-slate-50 hover:bg-slate-100 text-slate-500 hover:text-slate-700 flex items-center justify-center transition-colors cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
          </div>

          {/* Drawer Body */}
          <div className="flex-1 overflow-y-auto py-5 px-4 custom-scrollbar">
            <PagesPreview
              totalPages={totalPages}
              currentPage={currentPage}
              setCurrentPage={setCurrentPage}
              issues={issues}
              stage={stage}
              setStage={setStage}
              selectedFile={selectedFile}
            />
          </div>
        </div>
      </div>
    </>
  );
}
