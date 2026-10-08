# ProofDesk Next.js

ProofDesk is a chapter-aware PDF proofreading workspace for educational books with page-level visual review and annotations. It combines the Next.js review interface with MongoDB, PDF rendering, deterministic linting, cached chapter memory, Gemini analysis, queue, retry, and review workflows.

## What works

- Signed multipart Cloudinary PDF ingestion with file validation and atomic local downloads.
- MongoDB-backed books, pages, progress, failures, issues, and review decisions.
- Backend-owned page queue with pause, resume, stale-job recovery, bounded retries, and free-tier-safe default concurrency of one.
- Deterministic text checks before AI visual analysis.
- Versioned chapter indexing and cached whole-chapter context for story continuity, activities, concepts, terminology, and topic alignment without resending the full chapter for every page.
- Real progress based on saved page state—no simulated progress timer.
- PDF review canvas with evidence boxes, manual marks, keyboard navigation, accepted/dismissed decisions, and annotated PDF/CSV/JSON export.
- Optional application-wide Basic authentication for private deployments.

## Local setup

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Configure MongoDB, Cloudinary, and a Gemini API key in `.env.local`. For scanned documents, install the Tesseract executable and the trained data for your document language. Open `http://localhost:3000`.

## Production

Build and run as a long-lived Node service:

```bash
cd frontend
npm run build
npm start
```

The analysis queue requires a long-running Node process. PDFs and page images remain in Cloudinary; local files are a rebuildable cache. Do not deploy the worker path as short-lived serverless functions without a separate durable worker. Use HTTPS and configure both `PROOFDESK_BASIC_USER` and `PROOFDESK_BASIC_PASSWORD` unless authentication is enforced upstream.

See [the architecture notes](frontend/docs/ARCHITECTURE.md) and [ADR-001](frontend/docs/ADR-001-INTERNAL-NEXT-BACKEND.md) for workflow, security, deployment, migration, and remaining multi-user work.
