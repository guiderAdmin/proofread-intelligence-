# ProofDesk Next.js architecture

## User workflow

1. The browser requests a five-minute, PDF-only S3 upload URL.
2. The browser uploads directly to the private bucket, avoiding large request bodies in Next.js.
3. `POST /api/analyze` streams that object to private local storage, validates the `%PDF-` signature, creates a MongoDB `Book`, creates one durable `Page` job per page, and removes the temporary S3 object.
4. A MongoDB worker lease enforces one global AI worker across Node processes, then the queue claims page records atomically. Each page is rendered, text/layout are extracted, deterministic checks run, Gemini performs evidence-based visual review, and the result is saved before the next page is claimed.
5. The UI polls durable job state. Closing the browser does not erase results; opening the job again resumes polling and wakes queued work on the long-running Next.js host.
6. Review decisions are PATCHed to the page issue record, book statistics are recalculated, and CSV/JSON exports read saved state.

## Deployment boundary

This implementation intentionally targets `next start` / the included standalone Node server. The in-process queue needs a long-running Node process and persistent `PROOFDESK_STORAGE_DIR`; it is not safe to deploy the worker portion as short-lived serverless functions. MongoDB remains the source of truth, so stale page claims can be recovered after a process restart.

## Security controls

- Server-generated object keys prevent clients from choosing arbitrary S3 keys.
- Upload size, extension, MIME type, path, and PDF magic bytes are checked.
- Mutating API calls reject cross-origin browser requests by default.
- AWS, MongoDB, and Gemini credentials stay server-only.
- Files are written with private permissions and served with private cache headers.
- Optional HTTP Basic authentication protects the whole app when both `PROOFDESK_BASIC_*` values are configured. Production must use HTTPS.
- API errors do not return provider credentials or internal stack traces.

## Remaining production work

For a multi-user public service, replace application-wide Basic authentication with user accounts and add an owner identifier to every book/page query. Move originals and rendered pages to durable object storage if the Node host does not provide persistent disk. Add a dedicated worker process when analysis volume outgrows one globally throttled queue.
