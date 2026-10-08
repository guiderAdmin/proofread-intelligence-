import mongoose from "mongoose";

const issueSchema = new mongoose.Schema(
  {
    uid: { type: String, required: true },
    type: {
      type: String,
      enum: [
        "spelling",
        "grammar",
        "punctuation",
        "page_number",
        "chapter_alignment",
        "unit_alignment",
        "heading",
        "flow",
        "learning_outcomes",
        "image",
        "examples",
        "wording",
        "alignment",
        "layout",
        "typography",
        "spacing",
        "overflow",
        "inconsistency",
        "number",
        "other",
      ],
      default: "other",
    },
    severity: {
      type: String,
      enum: ["critical", "major", "minor"],
      default: "major",
    },
    quote: { type: String, default: "" },
    suggestion: { type: String, default: "" },
    explanation: { type: String, default: "" },
    box: {
      ymin: { type: Number, default: 0 },
      xmin: { type: Number, default: 0 },
      ymax: { type: Number, default: 1000 },
      xmax: { type: Number, default: 1000 },
    },
    boxSource: {
      type: String,
      enum: ["ai", "pdf_text", "ocr_text", "unverified"],
      default: "ai",
    },
    source: { type: String, enum: ["ai", "linter", "sage"], default: "ai" },
    textStart: { type: Number, min: 0 },
    textEnd: { type: Number, min: 0 },
    seenInLatestAnalysis: { type: Boolean, default: true },
    firstDetectedAt: Date,
    lastDetectedAt: Date,
    confidence: { type: Number, default: 0.7 },
    status: {
      type: String,
      enum: ["open", "accepted", "dismissed", "fixed"],
      default: "open",
    },
  },
  { _id: false }
);

const pageSchema = new mongoose.Schema(
  {
    bookId: { type: mongoose.Schema.Types.ObjectId, ref: "Book", index: true },
    pageNumber: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "processing", "done", "error"],
      default: "pending",
      index: true,
    },
    imagePath: String,
    textExtract: { type: String, default: "" },
    structuredText: { type: String, default: "" },
    textLayout: { type: [mongoose.Schema.Types.Mixed], default: [] },
    uncertainWords: { type: [String], default: [] },
    evidencePrepared: { type: Boolean, default: false },
    evidenceWarning: { type: String, default: "" },
    evidenceIndexed: { type: Boolean, default: false },
    coverage: { type: mongoose.Schema.Types.Mixed, default: null },
    chapterKey: { type: String, default: "", index: true },
    chapterContextVersion: { type: String, default: "" },
    pageKind: { type: String, default: "" },
    layoutNotes: { type: String, default: "" },
    issues: { type: [issueSchema], default: [] },
    issueRevision: { type: Number, default: 0, min: 0 },
    error: String,
    tokensUsed: { type: Number, default: 0 },
    analyzedAt: Date,
    analysisRunId: String,
    analysisModel: String,
    processingHeartbeatAt: Date,
    analysisWarnings: { type: [String], default: [] },
  },
  { timestamps: true }
);

pageSchema.index({ bookId: 1, pageNumber: 1 }, { unique: true });

// Next dev retains models across hot reloads. Install newly added evidence fields
// on that schema too, otherwise strict updates silently discard preparation state.
const cachedPage = mongoose.models.Page;
if (cachedPage) {
  for (const field of ["evidencePrepared", "evidenceWarning"]) {
    if (!cachedPage.schema.path(field)) cachedPage.schema.add({ [field]: pageSchema.path(field).options });
  }
}
export default cachedPage || mongoose.model("Page", pageSchema);
