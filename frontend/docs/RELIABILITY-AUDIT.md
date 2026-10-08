# ProofDesk reliability audit — 7 October 2026

## Scope and verified result

Changes are directly in `/Users/guider/Desktop/Proofreader Agent/frontend`, the main Antigravity checkout. Existing chapter proofreading, saved sessions, review decisions and other local changes were preserved. The audit covered ingestion/storage, PDF/OCR evidence, occurrence matching, model parsing, saved findings, SAGE context, browser state, queue recovery, chapter/index provenance, exports and production packaging.

The actual saved 99-page source PDF was inspected. Physical PDF pages 3, 4 and 6 are scans without a usable native text layer. Page 3 contains the exact coloured heading `words Patterns`; its main `Patterns` heading is already capitalised. A lowercase first word in the smaller heading is the reported error. It should be `Words Patterns`.

## Confirmed causes

1. **Missed heading:** full-page Tesseract segmentation omitted the white-on-green heading. A sparse pass on the application's renderer also missed it. Similar-looking rasterisations produced different recognition. Low-confidence words were discarded without preserving uncertainty, and OCR line/block metadata was lost. A general heading check did not exist.
2. **Findings disappeared:** earlier implementations deduplicated repeated phrases without distinguishing their occurrence and replaced the findings array on reanalysis. SAGE discoveries were only chat text. A later model response could omit a previous error, so the recorded set changed between turns.
3. **Wrong sidebar references:** the sidebar displayed array position plus one while SAGE received a re-ranked array without that display mapping. In the observed reply, SAGE's entries 12–14 referred to page 3/4 findings, whereas the displayed sidebar entries 12–14 belonged to page 6.
4. **Unverified positions:** OCR streams interleaved columns, and a jump guard rejected genuine wrapped phrases. The three page 6 quotes are present and recoverable in their own columns. Client caches could retain missing/stale location results and overwrite better evidence.
5. **Insufficient context:** SAGE had a short page extract and truncated conversation; no chapter/index context was supplied. The scanned book's native-text index fell back to one uncertain chapter covering pages 1–99. A failed asynchronous chapter-memory request left later pages with empty context.
6. **Crash/deployment paths:** the Tesseract.js language loader could throw in its worker outside the web handler's try/catch. Background timers after a serverless response did not guarantee execution. In-memory failure counters reset on cold starts. Parsing a 235 MB scanned source again with pdf-lib added avoidable memory pressure.

## Implemented changes

- Preserve earlier findings and human decisions with stable UIDs and conditional revisions; omission is labelled as retention rather than resolution. Distinct repeated occurrences remain separate. Review API updates are atomic. Late browser geometry results cannot replace current findings or decisions.
- OCR uses a lossless render, word rectangles, paragraph/block/line metadata and a preserved uncertainty list. A sparse pass and a bounded mask of saturated horizontal banners recover isolated headings and white text. The mask retains full-page coordinates. Low-confidence decorative fragments and wrapped exercise text cannot become heading findings merely because one word has a tall bounding box.
- Measured heading checks run before remote analysis and remain part of the final reconciliation. The rule capitalises the first word while preserving the remaining heading style.
- Review the full page and all four high-resolution quadrants in two bounded model calls. Save the first successful pass before starting the second; incomplete/truncated responses fail visibly while prior results survive. Coverage requires all four region identifiers. This validates completion of the requested sweep, not perfect semantic recall.
- Match phrases through OCR paragraphs and column-specific reading streams, including legitimate line wraps and rotated native text. Already-correct case/punctuation cannot be grounded as an error. A failed client location lookup is cached for that evidence version; improved server evidence takes priority.
- Send SAGE the actual sidebar number-to-UID/page mapping. Validate stale/duplicate mappings. Issue-location questions use the requested saved records and measured evidence directly. Supply longer page context, earlier conversation, index/chapter evidence and uncertainty. Verified SAGE observations are saved and retained across later replies. Saved context remains usable during source-storage failure.
- Update scanned index/chapter evidence from recovered text. Keep printed TOC labels separate from physical PDF pages. Explicitly report partial coverage and uncertain boundaries. Chapter builds are awaited and bounded; failures fall back to source excerpts and have a retry cooldown.
- Isolate JavaScript OCR in a child process with timeout/cleanup. Include its worker, language runtime/WASM and PDF fonts in deployment traces. Persist provider failure counts. Use one overall multipart download deadline and private staging. Avoid a second whole-book parse for large/scanned page inputs and avoid an extra source-buffer copy.
- Use an awaited one-page worker request on serverless hosts; status GETs are read-only. A same-origin browser drives serial slices. The optional persistent worker supports unattended processing on a persistent Node host. No scheduler endpoint is enabled. Claims, heartbeat and revisions fence revoked/duplicate work.
- Preserve prior ingestion, validation, streaming cancellation, manual-mark serialization, API error handling and production startup fixes. Existing main checkout uses `next start` with public/static assets available.

## Actual-page verification

Offline OCR and measured matching were rerun against the original PDF, without a paid whole-book model run:

| PDF page | Verified outcome |
| --- | --- |
| 3 | `words Patterns` recovered and flagged as `Words Patterns`; measured box approximately x 615–743, y 688–700 on the 0–1000 page scale. The long wrapped alphabet instruction also locates. |
| 4 | Both `will Complete` occurrences locate independently. The short/long quoted variants reconcile at the same changed-text offset rather than creating another error at one location. |
| 6 | All three previously unverified grammar/punctuation quotes locate in their correct columns; the tallest OCR descender is not flagged as a heading. |

The reported saved session was updated with this verified evidence, using a backup and conditional revisions. Page 3 now has five findings including the heading, page 4 has six, and page 6 has three. The total is 17; seven pages remain completed and the book remains paused. Existing UIDs and human decisions were retained. A visible warning distinguishes refreshed text locations from a new full visual review.

The original page 3/4/6 OCR results, current model/provider behavior and saved sessions are distinct evidence. An older screenshot and the later saved job belong to separate analysis jobs; re-uploading creates a new history. Code retention operates within a saved job and cannot recreate an unrecorded observation from another job.

## Validation

`npm test`: **90 passed, 0 failed, 0 skipped**. Includes real scanned OCR, white-on-green heading recovery, rotated/cropped native text, column wrapping, sidebar numbering, Mongoose document context, full SAGE observation persistence, earlier accepted decisions, source outages, child-process language faults, strict model coverage, partial pass failures, revoked claims, awaited worker responses, scheduler authentication, storage/API validation and existing review races.

The final production build, lint/type checks and `git diff --check` all passed. Worker deployment traces include `ocr-child.cjs`, Tesseract worker/core and PDF standard fonts. Local production smoke checks returned HTTP 200 for the homepage, sampled JavaScript/CSS, PDF worker, database health and saved-job API. Unauthorised scheduled/browser worker requests returned 401/403. The actual SAGE handler correctly located current sidebar issues 13, 14 and 15 on page 6 without a paid model request. The development server was restarted on localhost:3000 to load the new schemas. Node's direct test imports emit harmless module-autodetection warnings; a browser-PDF test emits a standard-font fixture warning. These do not indicate production compilation failure.

## Deployment operation and limits

Run `npm run build` then `npm start` from `frontend/`. On Vercel, enable Fluid compute and keep the application open while processing. Closing it preserves saved results; reopen/resume to continue. No cron job or scheduled GET endpoint is enabled. The optional `npm run worker` is for persistent Node hosts only.

The worker route declares 300 seconds and uses a 280-second work budget. Vercel Fluid compute documents a 300-second default, with plan-dependent maxima; verify the deployment duration setting. See [Vercel duration configuration](https://vercel.com/docs/functions/configuring-functions/duration). OCR configuration is in `.env.example`, including `OCR_LANG_PATH` for language data and the isolated fallback.

Tests establish the reported fixes and covered failure behavior; they cannot establish that every possible crash or every AI/OCR miss is impossible. The remaining 92 pages of this paused book were not automatically reanalysed. Chapter boundaries are explicitly uncertain until observed evidence establishes them. A second visual pass adds model cost. Ordinary Cloudinary delivery URLs and optional application Basic authentication are unchanged; a public multi-user product requires authenticated asset delivery and ownership checks. Provider/database outages and unreadable scans remain visible operational failures, with findings preserved.


## Upload and chat regression follow-up

Whole-book text/chapter indexing was removed from upload enqueue; durable page jobs are created immediately and the awaited worker builds evidence progressively. Same-book SAGE refresh preserves the existing File, review position and object URL. Unlocated language candidates are withheld with explicit analysis warnings; historical candidates remain available but cannot be accepted until measured. Colon matching cannot cross extraction lines. Browser POST is the only serverless worker entry point; scheduled GET returns 405 and scheduler middleware/auth configuration was removed. Page 4 alphabet reasoning is revisited as an explicit regression, without deleting earlier findings.

The actual page 4 image confirms E → I → H → L → K, with +4, +1, +4, +1 printed under the arrows despite the explanation saying one letter backward. A deterministic check requires both the measured sequence and matching explanation, then flags each incorrect +1 independently as -1 at its own measured location. A real OCR fixture verifies both occurrences and proves correctly printed -1 labels are left alone. Native bookmark/TOC extraction remains in the awaited worker, outside upload enqueue.

Follow-up validation: 96 automated tests passed, including the actual page 4 OCR fixture and an API-level check that ordinary SAGE messages do not restore the source PDF. Production compilation, lint/type checks, and diff whitespace checks passed. No development or production server was started during this follow-up. Live Vercel deployment remains untested. Enable Fluid compute on Hobby for the configured 300-second requests; processing is browser-driven and saved progress resumes when reopened. These changes remove upload indexing overhead, not Cloudinary network transfer time.

## Single-request cost policy (supersedes the earlier two-pass design)

At the user's request, the automatic second page review and all quadrant crop rendering/attachments were removed. Page analysis makes one model request with one full-page attachment. The main image is legible at a bounded 1600–2000 pixels on the longest edge; no crop bundle is generated. Earlier findings, review decisions, deterministic heading/alphabet checks, OCR measurements and revisions remain intact. Page coverage records one completed analysis pass, not four crop reviews.

Gemini SDK retry attempts are explicitly 1, meaning zero retries. Application retry/fallback loops were removed. SAGE is user-driven; chapter generation remains enabled with reused content-hash memories and bounded section calls. Failed chapter memory is not silently retried for unchanged source evidence. Failures are visible and saved; explicit resume/reanalysis can make a fresh paid request. Existing output and chapter budgets remain bounded. Request-level tests intercept the SDK transport, verify one attachment/call, and verify provider failures do not retry even with obsolete fallback environment settings. No paid model request is needed for these tests.

Single-request validation: 101 tests passed, production build/lint/type checks passed, and diff whitespace checks passed. The user's existing localhost:3000 homepage returned HTTP 200 with the application rendered after the isolated production build. No new server was started, no saved book was automatically reanalysed, and request-cost tests used intercepted SDK responses rather than paid provider calls. The new actual INR cost requires a subsequent real run; the previous two-pass estimate does not describe this implementation.
