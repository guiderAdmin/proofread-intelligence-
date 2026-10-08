# ProofDesk Next.js architecture

## User workflow

1. The browser requests signed Cloudinary upload tickets and uploads the PDF in chunks of approximately 9.5 MB. The whole file is limited to 250 MB and at most 64 parts.
2. `POST /api/analyze` creates a MongoDB `Book`, streams the parts into a private staging file, validates the PDF signature, atomically publishes the local file, and creates one durable `Page` job per PDF page. Partial failures remove orphan page jobs and multipart source assets.
3. A MongoDB worker lease throttles analysis across Node processes. Atomic page claims carry a run identifier so abandoned workers cannot overwrite newer work. Original PDFs and rendered JPEG pages remain in Cloudinary until the saved book is deleted.
4. PDF text and word geometry provide deterministic checks and evidence locations. Sparse/scanned pages or unresolved quotations can also use Tesseract OCR. Gemini reviews one full-page attachment in a single request. No quadrant crops, automatic revisit, model fallback, or application/SDK retry is enabled. Valid results are saved before completion; previous findings and review decisions survive omissions. The single full-page image is rendered with a bounded 1600–2000-pixel longest edge for readability. Small native PDFs can be attached directly; large/scanned sources use images and OCR to avoid parsing the entire book again with pdf-lib. Repeated errors receive separate findings when their locations differ.
5. Reanalysis reconciles findings with saved findings and review decisions. A page revision and conditional update prevent a review decision arriving during analysis from being overwritten. Failed/truncated model output is surfaced as a failure rather than an apparently clean result.
6. The UI polls durable job state. Review decisions update one issue atomically. Manual marks are validated and saved in request order; job switches flush pending saves. CSV/JSON and annotated PDF exports use saved findings.

## PDF coordinates and chapter context

Issue boxes use a top-left origin normalized to 0–1000; manual marks use page percentages. Both client and server use the same text occurrence matcher. Native PDF text boxes include page rotation and font metrics. OCR pixel boxes are normalized using the actual rendered image dimensions. Ambiguous or unavailable text matches keep the finding visible with an unverified location; the review canvas suppresses unverified textual rectangles. Inherently visual findings can retain their estimated model boxes.

Printed table-of-contents page labels are distinct from PDF page indices. A cover or front-matter offset must never be inferred from the printed number alone. Printed entries remain useful summary context, explicitly marked as having an unverified PDF position. Expected chapter/unit context uses resolved native bookmark page destinations; legacy chapter maps without numbering provenance abstain.

## OCR runtime

A local Tesseract executable is preferred. When the executable is absent, the existing `tesseract.js` dependency performs OCR with its language cache in the temporary directory. Its worker is terminated on completion or timeout. OCR is enabled by default and attempts scanned/sparse pages or unresolved quotations; set `OCR_ENABLED=false` to disable it. `TESSERACT_CMD` selects the executable path. An empty `OCR_LANGUAGE` uses the book language (`eng` for English, `hin` for Hindi); the corresponding trained data must be installed. `OCR_TIMEOUT_MS` defaults to 30000 and is bounded to 1–60 seconds.

OCR uses a separate lossless render at a requested 300 DPI, capped at 3200 pixels on the long edge, rather than the lower-resolution review JPEG. Tesseract TSV word boxes use the resulting image dimensions; words below 35% confidence remain in the uncertainty list. Block, paragraph and line IDs are retained. Sparse recognition and an inverted banner mask recover isolated labels and white text on saturated coloured headings. Heading checks require measured text and reject low-confidence decoration and ordinary wrapped body text. Missing binaries, language data, timeouts, or unreadable OCR results produce `analysisWarnings`. OCR cannot guarantee correct reading of decorative fonts, diagrams, or low-quality scans. See the [official Tesseract CLI documentation](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html).

## Deployment boundary

`POST /api/worker` requires a same-origin browser and awaits one page job within a 280-second budget. GET is disabled (405); there is no scheduler authentication bypass. Mongo claims, leases and heartbeat recovery prevent duplicate work. On Vercel the browser serially requests slices while analysis is active; reopening resumes saved work. The optional `npm run worker` is only for persistent Node hosts. Worker and SAGE routes set `maxDuration=300`, within Hobby Fluid compute limits.

`npm run build` creates the Next.js production build; `npm start` runs `next start`. Keep the build directory and `public/` alongside the application, including the PDF worker. Standalone server packaging is not used in this main checkout.

## Controls and remaining limits

- Upload keys, multipart counts, PDF size/signature, route IDs, JSON bodies, and manual-mark geometry are validated. Local downloads have private permissions and are published atomically; parallel workers share in-flight downloads.
- PDF responses apply backpressure, stop remote downloads when cancelled, and use safe Unicode filename headers. Remote storage requests have time limits.
- Mutating API calls reject cross-origin browser requests by default. Credentials stay server-side. Optional application-wide Basic authentication requires both `PROOFDESK_BASIC_*` settings and HTTPS.
- Cloudinary URLs in this implementation are ordinary delivery URLs; application authentication does not make those assets private. A public multi-user service needs authenticated storage delivery plus user ownership on all book/page queries.
- Cloudinary cleanup is best effort, and external database/provider outages can still prevent processing. The regression suite uses isolated model/provider boundaries; live provider accuracy and an existing production database require a configured runtime smoke test.

The existing `feature/chapter-proofreader` preparation and cached chapter context remain active. Page findings retain chapter keys and context versions while reconciliation preserves earlier findings and human decisions.

## Model request cost policy

Each page analysis or explicitly requested reanalysis makes one model request. SAGE makes a conversational model request only in response to a user message; navigation and deterministic location replies may use no model request. Chapter memory generation remains enabled and reused by content hash, with at most the configured bounded section calls per chapter. Failed chapter builds are not automatically retried for the same hash. All Gemini SDK requests set retry attempts to 1 (one original attempt, zero retries). A failed page is saved as an error; no silent automatic requeue occurs. Explicit resume/reanalysis can incur a fresh request. OCR, geometry, and deterministic checks use server resources but no model API calls. Existing paid output caps and low thinking configuration are retained.
