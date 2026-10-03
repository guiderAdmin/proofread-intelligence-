import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ["user", "assistant"], required: true },
  content: { type: String, required: true },
  pageNumber: Number,
  hasCapture: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const knowledgeSchema = new mongoose.Schema({
  text: { type: String, required: true },
  scope: { type: String, enum: ["book", "chapter", "page"], default: "book" },
  pageNumber: Number,
  source: { type: String, enum: ["user", "setup", "system"], default: "user" },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const agentSessionSchema = new mongoose.Schema({
  bookId: { type: mongoose.Schema.Types.ObjectId, ref: "Book", unique: true, index: true, required: true },
  messages: { type: [messageSchema], default: [] },
  knowledge: { type: [knowledgeSchema], default: [] },
}, { timestamps: true });

export default mongoose.models.AgentSession || mongoose.model("AgentSession", agentSessionSchema);
