import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { HttpError } from "./validation.js";
// AWS SDK removed — using Cloudinary

export const MAX_PDF_BYTES = 250 * 1024 * 1024;
export const MAX_PDF_PARTS = 64;
const downloadsInFlight = new Map();

export function validateUploadKey(objectKey) {
  if (typeof objectKey !== "string" || objectKey.length > 300 ||
      !/^proofreader_assets\/pdf_[A-Za-z0-9._-]+$/.test(objectKey) || objectKey.includes("..")) {
    throw new HttpError(400, "Invalid uploaded PDF key");
  }
  return objectKey;
}

export function validatePdfParts(value = 1) {
  const parts = Number(value);
  if (!Number.isSafeInteger(parts) || parts < 1 || parts > MAX_PDF_PARTS) {
    throw new HttpError(400, `PDF must have between 1 and ${MAX_PDF_PARTS} upload parts`);
  }
  return parts;
}

export function pdfObjectUrl(objectKey, partIndex = 0, pdfParts = 1) {
  validateUploadKey(objectKey);
  const parts = validatePdfParts(pdfParts);
  if (!Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= parts) {
    throw new HttpError(400, "Invalid PDF upload part index");
  }
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) throw new Error("Cloudinary upload storage is not configured");
  const partKey = parts > 1 ? `${objectKey}.part${partIndex}` : objectKey;
  const downloadKey = partKey.toLowerCase().endsWith(".pdf") ? partKey : `${partKey}.pdf`;
  return `https://res.cloudinary.com/${encodeURIComponent(cloudName)}/raw/upload/${downloadKey.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Root directory for local temporary files during processing.
 * On Vercel only /tmp is writable; on a persistent server we use .data/uploads.
 */
export function storageRoot() {
  const custom = process.env.PROOFDESK_STORAGE_DIR;
  if (custom) {
    process.env.UPLOADS_DIR = custom;
    return custom;
  }
  // VERCEL env var is automatically set to "1" in all Vercel deployments.
  const root = process.env.VERCEL
    ? os.tmpdir()
    : path.join(process.cwd(), ".data", "uploads");
  process.env.UPLOADS_DIR = root;
  return root;
}

export function safePdfName(name = "document.pdf") {
  const base = path.basename(String(name)).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-140) || "document.pdf";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

export function bookPdfPath(bookId, originalName) {
  return path.join(storageRoot(), String(bookId), safePdfName(originalName));
}

/**
 * Returns a writable temp path for the PDF during a single processing invocation.
 * Uses /tmp so it works on both Vercel and persistent servers.
 */
export function tempPdfPath(bookId) {
  return path.join(os.tmpdir(), `proofdesk_${bookId}.pdf`);
}

/**
 * Download a PDF from Cloudinary to a local path for processing.
 * objectKey = "proofreader_assets/pdf_UUID_name" (no .pdf extension for raw resources)
 */
export async function downloadPdfObject(objectKey, pdfParts, destination) {
  validateUploadKey(objectKey);
  const parts = validatePdfParts(pdfParts ?? 1);
  const cacheKey = `${path.resolve(destination)}:${objectKey}:${parts}`;
  if (downloadsInFlight.has(cacheKey)) return downloadsInFlight.get(cacheKey);
  const pending = downloadPdfToFile(objectKey, parts, destination);
  downloadsInFlight.set(cacheKey, pending);
  try {
    await pending;
  } finally {
    downloadsInFlight.delete(cacheKey);
  }
}

async function downloadPdfToFile(objectKey, parts, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  // Readers must never see a half-downloaded file. Parallel workers share the
  // completed download; separate processes still publish atomically by rename.
  const staging = `${destination}.${crypto.randomUUID()}.download`;
  let handle;
  let totalBytes = 0;
  const downloadSignal = AbortSignal.timeout(60_000);
  try {
    handle = await fsp.open(staging, "wx+", 0o600);
    for (let i = 0; i < parts; i += 1) {
      const response = await fetch(pdfObjectUrl(objectKey, i, parts), {
        cache: "no-store", signal: downloadSignal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Uploaded PDF part ${i} could not be read from storage (HTTP ${response.status})`);
      }
      const announcedBytes = Number(response.headers.get("content-length"));
      if (announcedBytes > MAX_PDF_BYTES - totalBytes) {
        await response.body?.cancel().catch(() => {});
        throw new HttpError(413, "PDF exceeds the 250 MB limit");
      }
      if (!response.body) throw new Error(`Uploaded PDF part ${i} has no content`);
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_PDF_BYTES) throw new HttpError(413, "PDF exceeds the 250 MB limit");
          const buffer = Buffer.from(value);
          let written = 0;
          while (written < buffer.length) {
            const result = await handle.write(buffer, written, buffer.length - written, null);
            if (!result.bytesWritten) throw new Error("Unable to write the downloaded PDF");
            written += result.bytesWritten;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    const magic = Buffer.alloc(5);
    await handle.read(magic, 0, 5, 0);
    if (magic.toString("ascii") !== "%PDF-") throw new HttpError(400, "Uploaded file is not a valid PDF");
    await handle.close();
    handle = null;
    await fsp.rename(staging, destination);
  } finally {
    await handle?.close().catch(() => {});
    await fsp.unlink(staging).catch(() => {});
  }
}

/**
 * Upload a rendered JPEG page image buffer to Cloudinary.
 * Returns the public secure_url for permanent storage in MongoDB.
 */
export async function uploadPageImage(jpegBuffer, bookId, pageNumber) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new Error("Cloudinary not configured");

  const folder = "proofreader_pages";
  const publicId = `${bookId}_page_${pageNumber}`;
  const timestamp = Math.round(Date.now() / 1000);

  // Parameters must be sorted alphabetically before signing
  const paramsToSign = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash("sha256").update(paramsToSign).digest("hex");

  const form = new FormData();
  form.append("file", new Blob([jpegBuffer], { type: "image/jpeg" }));
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  form.append("folder", folder);
  form.append("public_id", publicId);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Cloudinary page image upload failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  let imageUrl;
  try {
    imageUrl = new URL(data.secure_url);
  } catch {
    throw new Error("Cloudinary did not return a valid page image URL");
  }
  if (imageUrl.protocol !== "https:" || imageUrl.hostname !== "res.cloudinary.com") {
    throw new Error("Cloudinary did not return a valid page image URL");
  }
  return imageUrl.href;
}

/**
 * Delete a single page image from Cloudinary.
 */
export async function deletePageImage(bookId, pageNumber, signal = AbortSignal.timeout(30_000)) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return;

  const publicId = `proofreader_pages/${bookId}_page_${pageNumber}`;
  const timestamp = Math.round(Date.now() / 1000);
  const paramsToSign = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash("sha256").update(paramsToSign).digest("hex");

  const form = new FormData();
  form.append("public_id", publicId);
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);

  await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/destroy`, {
    method: "POST",
    body: form,
    signal,
  }).then((response) => response.body?.cancel()).catch(() => {});
}

/**
 * Delete all page images for a book from Cloudinary (called when book is deleted).
 */
export async function deleteAllPageImages(bookId, pageCount) {
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) return;
  const signal = AbortSignal.timeout(30_000);
  // Bound simultaneous remote requests for large books.
  for (let start = 1; start <= pageCount; start += 8) {
    if (signal.aborted) break;
    const tasks = [];
    for (let i = start; i <= Math.min(start + 7, pageCount); i += 1) {
      tasks.push(deletePageImage(bookId, i, signal));
    }
    await Promise.allSettled(tasks);
  }
}

/**
 * Delete a raw file (uploaded PDF) from Cloudinary.
 * objectKey = "proofreader_assets/pdf_UUID_name" (no .pdf extension)
 */
export async function deleteUploadObject(objectKey, pdfParts) {
  let parts;
  try {
    validateUploadKey(objectKey);
    parts = validatePdfParts(pdfParts ?? 1);
  } catch {
    return;
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return;

  const signal = AbortSignal.timeout(30_000);
  for (let i = 0; i < parts; i++) {
    if (signal.aborted) break;
    const partKey = parts > 1 ? `${objectKey}.part${i}` : objectKey;
    // Cloudinary raw/destroy requires the extension to match the stored resource exactly
    const publicId = partKey.toLowerCase().endsWith(".pdf") ? partKey : `${partKey}.pdf`;
    const timestamp = Math.round(Date.now() / 1000);

    const paramsToSign = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
    const signature = crypto.createHash("sha256").update(paramsToSign).digest("hex");

    const form = new FormData();
    form.append("public_id", publicId);
    form.append("api_key", apiKey);
    form.append("timestamp", String(timestamp));
    form.append("signature", signature);

    await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/raw/destroy`, {
      method: "POST",
      body: form,
      signal,
    }).then((response) => response.body?.cancel()).catch(() => {});
  }
}
