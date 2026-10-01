# ProofDesk Next.js

ProofDesk is a page-by-page PDF proofreading workspace for educational books. This project now combines the polished Next.js review interface with the proven MongoDB, PDF rendering, deterministic linting, Gemini analysis, queue, retry, and review workflow from the earlier React/Express implementation.

## What works

- Private direct-to-S3 PDF ingestion with server-generated keys and file validation.
- MongoDB-backed books, pages, progress, failures, issues, and review decisions.
- Backend-owned page queue with pause, resume, stale-job recovery, bounded retries, and free-tier-safe default concurrency of one.
- Deterministic text checks before AI visual analysis.
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

Configure MongoDB, a private S3 bucket, and a Gemini API key in `.env.local`. Open `http://localhost:3000`.

## Production

Build and run as a long-lived Node service:

```bash
cd frontend
npm run build
npm start
```

The analysis queue requires a long-running Node process and persistent `PROOFDESK_STORAGE_DIR`. Do not deploy the worker path as short-lived serverless functions. Use HTTPS and configure both `PROOFDESK_BASIC_USER` and `PROOFDESK_BASIC_PASSWORD` unless authentication is enforced upstream.

See [the architecture notes](frontend/docs/ARCHITECTURE.md) and [ADR-001](frontend/docs/ADR-001-INTERNAL-NEXT-BACKEND.md) for workflow, security, deployment, migration, and remaining multi-user work.
