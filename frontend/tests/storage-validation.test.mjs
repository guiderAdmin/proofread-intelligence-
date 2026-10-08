import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  downloadPdfObject, deleteUploadObject, MAX_PDF_BYTES, pdfObjectUrl, uploadPageImage, validatePdfParts, validateUploadKey,
} from "../src/server/storage.js";
import {
  HttpError, pdfContentDisposition, readJsonBody, validateBookId, validateCustomMarks, validatePageNumber,
} from "../src/server/validation.js";

async function downloadFixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "proofdesk-storage-test-"));
  const originalFetch = globalThis.fetch;
  const originalCloud = process.env.CLOUDINARY_CLOUD_NAME;
  process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalCloud === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = originalCloud;
    await fs.rm(folder, { recursive: true, force: true });
  });
  return { folder, destination: path.join(folder, "book.pdf") };
}

test("parallel page workers share a download and only publish a complete PDF", async (t) => {
  const { folder, destination } = await downloadFixture(t);
  await fs.writeFile(destination, "%PDF-existing");
  let releaseBody;
  const bodyReleased = new Promise((resolve) => { releaseBody = resolve; });
  let startFetch;
  const fetchStarted = new Promise((resolve) => { startFetch = resolve; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    startFetch();
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("%PDF-")); },
      async pull(controller) {
        await bodyReleased;
        controller.enqueue(new TextEncoder().encode("complete content"));
        controller.close();
      },
    }));
  };
  const first = downloadPdfObject("proofreader_assets/pdf_test_book", 1, destination);
  await fetchStarted;
  const second = downloadPdfObject("proofreader_assets/pdf_test_book", 1, destination);
  assert.equal(await fs.readFile(destination, "utf8"), "%PDF-existing");
  releaseBody();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(await fs.readFile(destination, "utf8"), "%PDF-complete content");
  assert.deepEqual(await fs.readdir(folder), ["book.pdf"]);
});

test("multipart downloads concatenate the exact bytes in part order", async (t) => {
  const { destination } = await downloadFixture(t);
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return new Response(requests.length === 1 ? "%PDF-first" : "-second");
  };
  await downloadPdfObject("proofreader_assets/pdf_test_book", 2, destination);
  assert.equal(await fs.readFile(destination, "utf8"), "%PDF-first-second");
  assert.ok(requests[0].endsWith(".part0.pdf"));
  assert.ok(requests[1].endsWith(".part1.pdf"));
});

test("failed multipart download preserves a cached PDF and cleans staging files", async (t) => {
  const { folder, destination } = await downloadFixture(t);
  await fs.writeFile(destination, "%PDF-existing");
  let calls = 0;
  globalThis.fetch = async () => new Response(++calls === 1 ? "%PDF-first" : "Missing", { status: calls === 1 ? 200 : 404 });
  await assert.rejects(downloadPdfObject("proofreader_assets/pdf_test_book", 2, destination), /HTTP 404/);
  assert.equal(await fs.readFile(destination, "utf8"), "%PDF-existing");
  assert.deepEqual(await fs.readdir(folder), ["book.pdf"]);
});

test("invalid PDF content and oversized storage responses are never published", async (t) => {
  const { folder, destination } = await downloadFixture(t);
  globalThis.fetch = async () => new Response("not a PDF");
  await assert.rejects(downloadPdfObject("proofreader_assets/pdf_test_book", 1, destination), { status: 400 });
  assert.deepEqual(await fs.readdir(folder), []);
  globalThis.fetch = async () => new Response("%PDF-", { headers: { "content-length": String(MAX_PDF_BYTES + 1) } });
  await assert.rejects(downloadPdfObject("proofreader_assets/pdf_test_book", 1, destination), { status: 413 });
  assert.deepEqual(await fs.readdir(folder), []);
});

test("failed downloads can be retried without a poisoned in-flight promise", async (t) => {
  const { destination } = await downloadFixture(t);
  globalThis.fetch = async () => { throw new Error("connection lost"); };
  await assert.rejects(downloadPdfObject("proofreader_assets/pdf_test_book", 1, destination), /connection lost/);
  globalThis.fetch = async () => new Response("%PDF-success");
  await downloadPdfObject("proofreader_assets/pdf_test_book", 1, destination);
  assert.equal(await fs.readFile(destination, "utf8"), "%PDF-success");
});

function mockStorageCredentials(t) {
  for (const name of ["CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) {
    const original = process.env[name];
    process.env[name] = "test-placeholder";
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }
}

test("invalid storage image responses cannot become apparently ready saved page URLs", async (t) => {
  await downloadFixture(t);
  mockStorageCredentials(t);
  globalThis.fetch = async () => Response.json({});
  await assert.rejects(uploadPageImage(Buffer.from("jpeg"), "test-book", 4), /valid page image URL/);
  globalThis.fetch = async () => Response.json({ secure_url: "http://res.cloudinary.com/insecure.jpg" });
  await assert.rejects(uploadPageImage(Buffer.from("jpeg"), "test-book", 4), /valid page image URL/);
  globalThis.fetch = async () => Response.json({ secure_url: "https://res.cloudinary.com/test-cloud/page4.jpg" });
  assert.equal(await uploadPageImage(Buffer.from("jpeg"), "test-book", 4), "https://res.cloudinary.com/test-cloud/page4.jpg");
});

test("multipart source deletion addresses each stored part with its PDF extension", async (t) => {
  await downloadFixture(t);
  mockStorageCredentials(t);
  const publicIds = [];
  globalThis.fetch = async (_url, options) => {
    publicIds.push(options.body.get("public_id"));
    return Response.json({ result: "ok" });
  };
  await deleteUploadObject("proofreader_assets/pdf_test_book", 2);
  assert.deepEqual(publicIds, ["proofreader_assets/pdf_test_book.part0.pdf", "proofreader_assets/pdf_test_book.part1.pdf"]);
});

test("route and upload inputs reject malformed ids, pages, keys and part counts", () => {
  assert.equal(validateBookId("0123456789abcdef01234567"), "0123456789abcdef01234567");
  assert.equal(validatePageNumber("4"), 4);
  for (const value of ["", "abc", null, "g".repeat(24)]) assert.throws(() => validateBookId(value), { status: 400 });
  for (const value of [0, -1, 1.2, NaN, Infinity, "abc"]) assert.throws(() => validatePageNumber(value), { status: 400 });
  for (const value of [0, -1, 1.5, Infinity, 65]) assert.throws(() => validatePdfParts(value), { status: 400 });
  for (const value of ["/etc/file", "proofreader_assets/pdf_../file", "proofreader_assets/pdf_x?foo=bar", "other/file", null]) {
    assert.throws(() => validateUploadKey(value), { status: 400 });
  }
  assert.throws(() => pdfObjectUrl("proofreader_assets/pdf_valid", 2, 2), { status: 400 });
});

test("JSON mutation bodies must be objects rather than null, arrays, or broken JSON", async () => {
  for (const value of [null, [], "text", 1]) {
    await assert.rejects(readJsonBody({ json: async () => value }), { status: 400 });
  }
  await assert.rejects(readJsonBody({ json: async () => { throw new SyntaxError("broken JSON"); } }), { status: 400 });
  assert.deepEqual(await readJsonBody({ json: async () => ({ status: "accepted" }) }), { status: "accepted" });
});

test("manual marks cannot poison saved review state with invalid arrays or coordinates", () => {
  const mark = { id: "mark-1", type: "highlight", x: 20, y: 30, w: 10, h: 2, page: 4, comment: "Check this" };
  assert.deepEqual(validateCustomMarks([mark], 10), [mark]);
  for (const marks of [null, {}, [mark, mark], [{ ...mark, x: NaN }], [{ ...mark, w: -1 }], [{ ...mark, page: 11 }], [{ ...mark, x: 99 }]]) {
    assert.throws(() => validateCustomMarks(marks, 10), { status: 400 });
  }
});

test("PDF download filenames safely preserve Unicode and remove invalid header characters", () => {
  const header = pdfContentDisposition('reasoning \"book\"\r\nहिन्दी 📕.pdf');
  assert.ok(header.includes('filename="reasoning _book___'));
  assert.ok(header.includes("filename*=UTF-8''reasoning"));
  assert.ok(header.includes(encodeURIComponent("हिन्दी")));
  assert.doesNotThrow(() => new Headers({ "Content-Disposition": header }));
  assert.doesNotThrow(() => pdfContentDisposition("malformed\uD800.pdf"));
  assert.equal(new HttpError(400, "bad").status, 400);
});
