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
  const staging = `${destination}.${crypto.randomUUID()}.download`;
  let handle;
  try {
    handle = await fsp.open(staging, "wx+", 0o600);
    const storageDir = storageRoot();
    for (let i = 0; i < parts; i += 1) {
      const partKey = parts > 1 ? `${objectKey}.part${i}` : objectKey;
      const partPath = path.join(storageDir, partKey);
      const buffer = await fsp.readFile(partPath);
      await handle.write(buffer, 0, buffer.length, null);
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
 * Upload a rendered JPEG page image buffer locally.
 * Returns the public url for permanent storage in MongoDB.
 */
export async function uploadPageImage(jpegBuffer, bookId, pageNumber) {
  const publicId = `page-${pageNumber}.jpg`;
  const storageDir = storageRoot();
  const targetPath = path.join(storageDir, String(bookId), publicId);
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, jpegBuffer);
  return `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/local-image?id=${encodeURIComponent(String(bookId) + "/" + publicId)}`;
}

export async function deletePageImage(bookId, pageNumber, signal) {
  const publicId = `page-${pageNumber}.jpg`;
  const targetPath = path.join(storageRoot(), String(bookId), publicId);
  await fsp.unlink(targetPath).catch(() => {});
}

export async function deleteAllPageImages(bookId, pageCount) {
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) return;
  for (let i = 1; i <= pageCount; i += 1) {
    await deletePageImage(bookId, i);
  }
  // Try to clean up the directory
  const dirPath = path.join(storageRoot(), String(bookId));
  await fsp.rmdir(dirPath).catch(() => {});
}

export async function deleteUploadObject(objectKey, pdfParts) {
  let parts;
  try {
    validateUploadKey(objectKey);
    parts = validatePdfParts(pdfParts ?? 1);
  } catch {
    return;
  }
  const storageDir = storageRoot();
  for (let i = 0; i < parts; i++) {
    const partKey = parts > 1 ? `${objectKey}.part${i}` : objectKey;
    const targetPath = path.join(storageDir, partKey);
    await fsp.unlink(targetPath).catch(() => {});
  }
}
