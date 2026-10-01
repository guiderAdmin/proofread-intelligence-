import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
// AWS SDK removed — using Cloudinary

export const MAX_PDF_BYTES = 250 * 1024 * 1024;

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
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-140);
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
  if (!objectKey || objectKey.includes("..") || objectKey.startsWith("/")) {
    throw new Error("Invalid upload key");
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) throw new Error("Cloudinary upload storage is not configured");

  await fsp.mkdir(path.dirname(destination), { recursive: true });
  // Clear the file if it exists so we can append to a clean file
  await fsp.writeFile(destination, Buffer.alloc(0));

  let totalBytes = 0;
  
  for (let i = 0; i < (pdfParts || 1); i++) {
    // If it's the only part, it has no suffix. Otherwise it's .part0, .part1, etc.
    const partKey = (pdfParts && pdfParts > 1) ? `${objectKey}.part${i}` : objectKey;
    const downloadKey = partKey.toLowerCase().endsWith(".pdf") ? partKey : `${partKey}.pdf`;
    
    const url = `https://res.cloudinary.com/${cloudName}/raw/upload/${downloadKey}`;
    const response = await fetch(url, { cache: "no-store" });

    if (!response.ok) {
      await fsp.unlink(destination).catch(() => {});
      throw new Error(`Uploaded PDF part ${i} could not be read from storage (HTTP ${response.status})`);
    }
    
    const buffer = await response.arrayBuffer();
    await fsp.appendFile(destination, Buffer.from(buffer));
    totalBytes += buffer.byteLength;
    
    if (totalBytes > 500 * 1024 * 1024) { // Increased limit to 500 MB
      await fsp.unlink(destination).catch(() => {});
      throw new Error("PDF exceeds the 500 MB limit");
    }
  }

  // Validate it's actually a PDF
  const handle = await fsp.open(destination, "r");
  try {
    const magic = Buffer.alloc(5);
    await handle.read(magic, 0, 5, 0);
    if (magic.toString("ascii") !== "%PDF-") throw new Error("Uploaded file is not a valid PDF");
  } catch (error) {
    await fsp.unlink(destination).catch(() => {});
    throw error;
  } finally {
    await handle.close();
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

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Cloudinary page image upload failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  return String(data.secure_url); // e.g. https://res.cloudinary.com/.../page_1.jpg
}

/**
 * Delete a single page image from Cloudinary.
 */
export async function deletePageImage(bookId, pageNumber) {
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

  await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
    method: "POST",
    body: form,
  }).catch(() => {});
}

/**
 * Delete all page images for a book from Cloudinary (called when book is deleted).
 */
export async function deleteAllPageImages(bookId, pageCount) {
  if (!pageCount || pageCount <= 0) return;
  const tasks = [];
  for (let i = 1; i <= pageCount; i++) {
    tasks.push(deletePageImage(bookId, i));
  }
  await Promise.allSettled(tasks);
}

/**
 * Delete a raw file (uploaded PDF) from Cloudinary.
 * objectKey = "proofreader_assets/pdf_UUID_name" (no .pdf extension)
 */
export async function deleteUploadObject(objectKey, pdfParts) {
  if (!objectKey || objectKey.includes("..") || objectKey.startsWith("/")) return;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return;

  for (let i = 0; i < (pdfParts || 1); i++) {
    const partKey = (pdfParts && pdfParts > 1) ? `${objectKey}.part${i}` : objectKey;
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

    await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/raw/destroy`, {
      method: "POST",
      body: form,
    }).catch(() => {});
  }
}
