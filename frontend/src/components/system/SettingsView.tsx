"use client";

import React from "react";
import { Settings, ShieldAlert } from "lucide-react";

export function SettingsView() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Settings className="h-5 w-5 text-brand-500" />
          SaaS Pipeline Configuration
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">Control endpoints and behavior thresholds of the transient frontend workspace.</p>
      </div>

      {/* Status card */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 flex items-start gap-4 shadow-sm">
        <div className="w-10 h-10 rounded-xl bg-white border border-slate-200 text-slate-400 flex items-center justify-center shrink-0">
          <ShieldAlert className="h-5 w-5" />
        </div>
        <div>
          <p className="text-xs font-bold text-slate-800 uppercase tracking-widest">In-Memory Active Session</p>
          <p className="text-[11px] text-slate-500 mt-1 leading-relaxed font-medium">
            All application changes, historical lists, and session restorations persist strictly in transient React memory. Closing or refreshing the page resets the state cleanly.
          </p>
        </div>
      </div>
    </div>
  );
}
