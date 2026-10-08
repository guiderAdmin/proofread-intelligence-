export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function validateBookId(id) {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
    throw new HttpError(400, "Invalid proofread id");
  }
  return id;
}

export function validatePageNumber(value) {
  const pageNumber = Number(value);
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    throw new HttpError(400, "Invalid page number");
  }
  return pageNumber;
}

export async function readJsonBody(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "A valid JSON object is required");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "A valid JSON object is required");
  }
  return body;
}

export function validateCustomMarks(marks, pageCount) {
  if (!Array.isArray(marks) || marks.length > 10_000) {
    throw new HttpError(400, "Manual marks must be an array of at most 10,000 items");
  }
  const ids = new Set();
  for (const mark of marks) {
    if (!mark || typeof mark !== "object" || typeof mark.id !== "string" ||
        !mark.id || mark.id.length > 200 || ids.has(mark.id) ||
        !["circle", "square", "highlight"].includes(mark.type) ||
        !Number.isSafeInteger(mark.page) || mark.page < 1 || mark.page > pageCount ||
        typeof mark.comment !== "string" || mark.comment.length > 10_000 ||
        ![mark.x, mark.y, mark.w, mark.h].every((value) => typeof value === "number" && Number.isFinite(value)) ||
        mark.x < 0 || mark.y < 0 || mark.w <= 0 || mark.h <= 0 ||
        mark.x + mark.w > 100.01 || mark.y + mark.h > 100.01) {
      throw new HttpError(400, "Manual mark has invalid identity, page, or coordinates");
    }
    ids.add(mark.id);
  }
  // Persist the supported fields only; arbitrary payload fields are not marks.
  return marks.map(({ id, type, x, y, w, h, comment, page }) => ({ id, type, x, y, w, h, comment, page }));
}

export function pdfContentDisposition(name) {
  // HTTP header values cannot contain CR/LF or non-Latin-1 characters. Keep a
  // safe ASCII fallback and use RFC 5987 for the original Unicode filename.
  const original = Array.from(String(name || "document.pdf").replace(/[\r\n]/g, "_"))
    .map((char) => char.length === 1 && /[\uD800-\uDFFF]/.test(char) ? "_" : char).join("");
  const ascii = original.replace(/[^\x20-\x7E]|["\\]/g, "_");
  const encoded = encodeURIComponent(original).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
