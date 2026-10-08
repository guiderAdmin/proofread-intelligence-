import mongoose from "mongoose";

const chapterContextSchema = new mongoose.Schema(
  {
    bookId: { type: mongoose.Schema.Types.ObjectId, ref: "Book", required: true, index: true },
    chapterKey: { type: String, required: true },
    chapterNumber: { type: Number, default: 0 },
    title: { type: String, default: "" },
    unit: { type: String, default: "" },
    startPage: { type: Number, required: true },
    endPage: { type: Number, required: true },
    boundaryConfidence: { type: Number, default: 0 },
    boundarySource: { type: String, default: "" },
    contentHash: { type: String, required: true },
    analysisVersion: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "processing", "ready", "error"],
      default: "pending",
      index: true,
    },
    memory: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    compactContext: { type: String, default: "" },
    sourceChars: { type: Number, default: 0 },
    tokensUsed: { type: Number, default: 0 },
    error: { type: String, default: "" },
    analyzedAt: Date,
  },
  { timestamps: true }
);

chapterContextSchema.index({ bookId: 1, chapterKey: 1 }, { unique: true });

export default mongoose.models.ChapterContext || mongoose.model("ChapterContext", chapterContextSchema);
