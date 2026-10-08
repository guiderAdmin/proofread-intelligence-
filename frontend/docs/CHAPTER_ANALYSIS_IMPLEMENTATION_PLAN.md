# Chapter-aware proofreading implementation plan

## Baseline finding and implementation status

Before this implementation, ProofDesk did not proofread a chapter as a complete semantic unit. It created one durable job per page and supplied only a best-effort chapter/unit label and short TOC string.

This has four important consequences:

1. A page cannot reliably validate characters, terminology, concepts, learning outcomes, answer keys, or omissions against the rest of its chapter.
2. Exercises are not represented as structured problems. The model may notice a superficial anomaly without solving the complete question.
3. Chapter structure extraction is asynchronous with page processing, so early page jobs can run before even the chapter label is stored.
4. SAGE normally receives extracted text and saved issue records. Before the live-snapshot change, it only received pixels when the user manually captured a region.

The implemented core now indexes chapter boundaries before page analysis, builds a versioned cached chapter memory from text and visual PDF chunks, and injects a bounded page-relevant chapter context into visual page review. Full chapter content is not repeated in every page-model request. The later reconciliation, evaluation-corpus, and rollout-control phases below remain hardening work.

## Product behavior to deliver

For every chapter, ProofDesk should be able to answer these questions with cited page evidence:

- What topics, definitions, characters, entities, rules, terminology, and learning outcomes does this chapter establish?
- What facts or naming conventions must remain consistent on later pages?
- Does each exercise test material actually taught in the chapter?
- Is every question answerable, is the intended answer present, and does the answer key agree?
- Are any expected concepts, story characters, steps, examples, captions, references, or chapter sections missing?
- Does a suspicious glyph represent a true error, or is it an OCR/visual ambiguity such as `I` versus `1`?

Page review remains the unit used for UI annotations, retry, acceptance, and export. Chapter analysis becomes the semantic coordination layer above it.

## Proposed architecture

### 1. Deterministic ingest and chapter boundaries

Extract text and layout metadata for all pages before starting paid page analysis. Build chapter boundaries from, in priority order:

1. PDF outline/bookmarks.
2. Printed TOC plus printed-page-to-PDF-page offset detection.
3. Chapter-heading detection on body pages.
4. A low-cost structure model only when deterministic evidence is insufficient.

Persist explicit `startPage`, `endPage`, confidence, and evidence for every chapter. Do not start page jobs until the structure state is `ready` or explicitly `degraded`.

### 2. Cached chapter memory

Add a `ChapterContext` record keyed by `bookId`, `chapterId`, content hash, prompt version, and model version. Store a compact structured digest rather than a prose-only summary:

- title, page range, unit, and learning objectives;
- topic and concept outline;
- definitions, formulas, rules, terminology, and required spelling/capitalization;
- character/entity registry with aliases, attributes, and page references;
- sequence/numbering state for headings, examples, figures, tables, and activities;
- exercise inventory with stems, options, expected answer type, derived answer, and source pages;
- answer-key mappings;
- unresolved ambiguities and confidence;
- evidence snippets with page numbers and bounding boxes where available.

Generate this record once per chapter and invalidate it only when the source hash, prompt, or model version changes.

### 3. Question-solving pass

Detect exercise blocks and parse them into structured items. For each item the model must:

1. Read the complete stem, supporting diagram, and all options.
2. Classify the problem type and expected answer type.
3. Solve it independently and record a short governing rule or derivation.
4. Compare the derived answer with the visible options and any answer key.
5. Check visually ambiguous glyphs against both pixels and problem semantics.
6. Emit an issue only when the evidence supports a concrete defect.

Saved linter findings are candidates to verify, never premises the model must accept. In the screenshot example, the system must solve `A, D, G, J, ?, P` first, recognize the +3 pattern and expected `M`, then decide whether the final glyph is the letter `I` or digit `1`. It must not invent `N` merely to make that option alphabetic.

### 4. Page analysis with retrieved chapter context

Each page call receives:

- the current high-resolution rendered page;
- the compact chapter card;
- the previous and next page continuation snippets;
- only the most relevant chapter evidence snippets retrieved for that page;
- relevant entity, terminology, numbering, and exercise records;
- project rules and previously confirmed user knowledge.

Do not attach the complete chapter text to every page. Cap the chapter context budget and record which evidence IDs were supplied so findings are reproducible.

### 5. Chapter reconciliation pass

After all pages in a chapter finish, run one reconciliation job over the structured chapter memory plus page findings. This pass detects cross-page defects that a page call cannot reliably find:

- a character or entity whose name/attribute changes;
- a promised learning outcome that is never taught or assessed;
- missing or duplicated examples, headings, questions, figures, or steps;
- inconsistent definitions, terminology, notation, capitalization, or units;
- an exercise whose answer depends on material absent from the chapter;
- an answer key that conflicts with the independently derived answer;
- continuation, narrative, numbering, and reference breaks across page boundaries.

Chapter findings must identify the primary annotation page plus supporting page references. Deduplicate them against page findings before saving.

### 6. Visual grounding for SAGE

SAGE receives no image for an ordinary question. It uses the selected/current issue, selected text, extracted page context, and project knowledge. It receives pixels only when the user attaches a region or explicitly requests full-page analysis; a region takes priority over a full-page capture. If a requested page canvas is unavailable, SAGE must say that visual analysis could not be completed.

For later optimization, cache the page image by `bookId + pageNumber + renderHash` and use provider-supported cached content when economical. Never treat an old capture as the current page after navigation.

## Data model changes

Add these durable records or equivalent embedded schemas:

- `Book.structureStatus`: `pending | ready | degraded | error`.
- `Book.analysisVersion`: pipeline/prompt/model version tuple.
- `ChapterContext`: identity, page range, hashes, structured memory, status, token usage, and timestamps.
- `Question`: page, bounding region, stem, options, answer type, derived answer, derivation, key answer, confidence, and evidence.
- `ChapterIssue`: issue payload, primary page, supporting pages/evidence IDs, verification status, and provenance.
- `Page.chapterId`, `Page.contextVersion`, and per-stage token usage.

Use unique indexes for `(bookId, chapterId, contentHash, analysisVersion)` and idempotency keys for every chapter job.

## Queue and execution roadmap

### Phase 0 — Safety baseline and evaluation fixtures

- Add regression fixtures for the supplied alphabet-series page, ambiguous `I/1`, answer-key mismatch, cross-page story character changes, missing learning outcomes, and chapter numbering gaps.
- Record expected issues, non-issues, page boxes, confidence, and supporting evidence.
- Add token/cost, latency, false-positive, and recall measurements.

Exit criterion: the current pipeline can be measured repeatably and the screenshot false positive is captured as a failing fixture.

### Phase 1 — Independent visual reasoning

- Attach a visual to SAGE only for a user-selected region or an explicit full-page analysis request.
- Make visual evidence primary and existing issue records advisory.
- Strengthen the page-analysis prompt to solve complete questions and handle ambiguous glyphs.
- Add telemetry for capture success and visual/no-visual responses.

Exit criterion: SAGE can independently explain the supplied sequence and does not suggest a same-type but logically unjustified replacement.

### Phase 2 — Reliable chapter indexing

- Extract all page text/layout before paid analysis.
- Make structure extraction an awaited queue stage.
- Resolve printed/PDF page offsets and persist chapter ranges with confidence.
- Provide a manual boundary override for low-confidence books.

Exit criterion: at least 95% of evaluation pages map to the correct chapter; no page analysis begins with structure still pending.

### Phase 3 — Chapter memory and retrieval

- Build and cache `ChapterContext` records.
- Add entities, concepts, learning outcomes, terminology, numbering, and evidence references.
- Retrieve a bounded context package for each page.
- Invalidate by source/prompt/model hash.

Exit criterion: page calls receive no full chapter dump, context stays within the configured budget, and chapter-dependent fixtures become detectable.

### Phase 4 — Exercise solver and answer validation

- Segment question blocks from layout and visuals.
- Persist structured questions and independently derived answers.
- Compare options and answer keys; verify ambiguous glyphs visually.
- Surface `reasoning rule`, `expected answer`, and `evidence` in review details without exposing private chain-of-thought.

Exit criterion: all logic fixtures are solved correctly and wrong-answer suggestions are blocked by validation.

### Phase 5 — Chapter reconciliation

- Run the post-page chapter audit.
- Create cross-page findings with supporting references.
- Deduplicate against page issues and support chapter reanalysis.
- Add chapter progress/status to the analysis UI.

Exit criterion: entity consistency, omissions, outcome coverage, numbering, and answer-key fixtures pass.

### Phase 6 — Cost and rollout controls

- Track tokens separately for indexing, chapter memory, page analysis, solving, and reconciliation.
- Reuse memories by hash and skip unchanged stages on reanalysis.
- Add feature flags: `visual_grounding`, `question_solver`, `chapter_context`, and `chapter_reconciliation`.
- Shadow-run on a representative corpus, compare against the page-only baseline, then roll out by book type.

Exit criterion: quality thresholds are met with an agreed per-page/per-chapter cost ceiling and rollback remains possible.

## Cost model

Chapter memory is not literally free: creating and reconciling it adds one-time input/output tokens. It avoids the much larger repeated cost of sending the entire chapter with every page. The intended steady-state budget is:

- one deterministic extraction pass;
- one cached memory-generation call per chapter;
- small bounded context retrieval per page;
- one reconciliation call per chapter;
- no repeated full-chapter payloads;
- no regeneration when hashes are unchanged.

Measure marginal cost per chapter and per corrected true-positive, not token count alone. The pipeline should fall back to page-only mode when chapter boundaries are unreliable or the configured budget is exhausted, and clearly label that reduced-context state.

## Acceptance criteria

- The system never claims chapter-aware analysis when only a chapter title was supplied.
- Every logic-question finding includes an independently derived expected answer and rule.
- Existing linter/issue output cannot force SAGE to agree with an incorrect flag.
- SAGE knows whether a live image was attached and discloses text-only fallback.
- Cross-page findings cite at least two pieces of evidence or explicitly identify a chapter-level omission check.
- Chapter context is versioned, cached, bounded, and reproducible.
- Reanalysis reuses unchanged chapter memory and does not duplicate findings.
- Users can distinguish page findings, question-validation findings, and chapter findings in review/export.
