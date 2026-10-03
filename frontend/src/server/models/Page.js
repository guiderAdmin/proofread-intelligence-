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
      enum: ["ai", "pdf_text"],
      default: "ai",
    },
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
    pageKind: { type: String, default: "" },
    layoutNotes: { type: String, default: "" },
    issues: { type: [issueSchema], default: [] },
    error: String,
    tokensUsed: { type: Number, default: 0 },
    analyzedAt: Date,
  },
  { timestamps: true }
);

pageSchema.index({ bookId: 1, pageNumber: 1 }, { unique: true });

export default mongoose.models.Page || mongoose.model("Page", pageSchema);
