/* eslint-disable */
import mongoose from "mongoose";

const bookSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    originalName: String,
    classLevel: { type: String, default: "" },
    subject: { type: String, default: "" },
    filePath: { type: String, required: true },
    pageCount: { type: Number, default: 0 },
    language: {
      type: String,
      enum: ["auto", "english", "hindi", "mixed"],
      default: "auto",
    },
    bookType: {
      type: String,
      enum: ["textbook", "workbook", "story", "general"],
      default: "textbook",
    },
    model: { type: String, default: "gemini-3.6-flash" },
    thinkingLevel: { type: String, default: "low" },
    status: {
      type: String,
      enum: ["queued", "processing", "paused", "done", "error"],
      default: "queued",
    },
    progress: {
      current: { type: Number, default: 0 },
      done: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    stats: {
      issues: { type: Number, default: 0 },
      critical: { type: Number, default: 0 },
      major: { type: Number, default: 0 },
      minor: { type: Number, default: 0 },
      accepted: { type: Number, default: 0 },
      dismissed: { type: Number, default: 0 },
    },
    structure: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({ toc: [], units: [], chapters: [] }),
    },
    customMarks: {
      type: mongoose.Schema.Types.Mixed,
      default: () => [],
    },
    error: String,
    // Cloudinary key of the source PDF — used to re-download the file for each
    // page processing invocation (required for stateless/serverless deployment).
    cloudinaryPdfKey: { type: String, default: "" },
    pdfParts: { type: Number, default: 1 },
  },
  { timestamps: true }
);

export default mongoose.models.Book || mongoose.model("Book", bookSchema);
