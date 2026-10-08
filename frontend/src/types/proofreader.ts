export interface ProofreaderIssue {
  id: number;
  backendUid?: string;
  category: string;
  type: string;
  severity: "critical" | "high" | "medium" | "low";
  originalText: string;
  suggestedText: string;
  explanation: string;
  locationHint: string;
  confidence: number;
  page?: number | null;
  pageIndex?: number;
  resolved?: boolean;
  ignored?: boolean;
  bbox?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  bboxSource?: "ai" | "pdf_text" | "ocr_text" | "unverified";
  seenInLatestAnalysis?: boolean;
}

export interface CustomMark {
  id: string;
  type: "circle" | "square" | "highlight";
  x: number;
  y: number;
  w: number;
  h: number;
  comment: string;
  page: number;
}

export interface ProofreaderPageData {
  page_number: number;
  image_url: string;
}

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface ProofreaderResponse {
  success: boolean;
  pagesReviewed: number;
  pagesExpected?: number;
  visualReviewPendingCount?: number;
  issueCount: number;
  printReady: boolean;
  severityCounts: SeverityCounts;
  issues: ProofreaderIssue[];
  perPage?: any[];
  model?: string;
}
