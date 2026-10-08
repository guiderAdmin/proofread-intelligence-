import mongoose from "mongoose";
import { storageRoot } from "./storage.js";

const globalCache = globalThis;

if (!globalCache.__proofdeskMongo) {
  globalCache.__proofdeskMongo = { connection: null, promise: null };
}

export async function connectDb() {
  storageRoot();
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not configured");

  const cache = globalCache.__proofdeskMongo;

  // If mongoose reports a broken/disconnected state, clear the cached promise
  // so we start a fresh connection. This fixes 404s after Next.js hot reloads.
  const readyState = mongoose.connection.readyState;
  if (readyState === 0 /* disconnected */ || readyState === 3 /* disconnecting */) {
    cache.connection = null;
    cache.promise = null;
  }

  if (cache.connection && readyState === 1) return cache.connection;

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(uri, {
        bufferCommands: false,
        serverSelectionTimeoutMS: 10_000,
      })
      .then((instance) => instance);
  }

  const pending = cache.promise;
  try {
    cache.connection = await pending;
    return cache.connection;
  } catch (error) {
    // A later caller may have begun a fresh reconnect after this attempt
    // failed. Do not clear that newer connection promise from an older catch.
    if (cache.promise === pending) cache.promise = null;
    throw error;
  }
}

export function mongoReady() {
  return mongoose.connection.readyState === 1;
}
