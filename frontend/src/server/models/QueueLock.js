import mongoose from "mongoose";

const queueLockSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    owner: { type: String, required: true },
    lockedUntil: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

export default mongoose.models.QueueLock || mongoose.model("QueueLock", queueLockSchema);
