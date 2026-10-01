# ADR-001: Replace n8n/Supabase orchestration with an internal Next.js backend

Date: 2026-09-23  
Status: Implemented

Problem: The Next.js UI simulated progress and depended on n8n plus Supabase for a single final payload. It did not own page jobs, retries, review decisions, or resumable state, while the working Proofreader project already implemented those behaviors with MongoDB.

Evidence: The former `/api/analyze` created a Supabase row and called a webhook; the client advanced a timer to 95%. The reference project persists `Book` and `Page` records, claims pages atomically, saves page results, and supports pause, resume, reanalysis, issue status, and export.

Decision: Keep the Next.js interface and direct-to-S3 ingestion, but run MongoDB models, PDF services, deterministic linting, Gemini analysis, queue control, and API contracts inside the Next.js Node runtime. Use polling against durable state rather than correctness-critical in-memory SSE.

Trade-offs: Deployment becomes one coherent application and jobs survive browser disconnects. A long-running Node host and persistent disk are required; short-lived serverless functions are not a supported worker runtime. Polling adds small read traffic but is restart-safe.

Migration: No source project or existing MongoDB data is modified. New uploads create the same Book/Page-shaped data used by the reference implementation. The removed Supabase/n8n path can be restored from Git if rollback is needed.

Verification: Type-check, production build, API validation tests, and a local MongoDB/Gemini smoke test are required. Provider calls cannot be fully verified without valid runtime credentials.
