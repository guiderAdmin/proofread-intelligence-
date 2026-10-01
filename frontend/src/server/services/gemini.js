import fs from "fs/promises";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { lintPageText } from "./linter.js";

const ISSUE_TYPES = [
  "spelling",
  "grammar",
  "punctuation",
  "page_number",
  "chapter_alignment",
  "unit_alignment",
  "heading",
  "flow",
  "learning_outcomes",
  "image",
  "examples",
  "wording",
  "alignment",
  "layout",
  "typography",
  "spacing",
  "overflow",
  "inconsistency",
  "number",
  "other",
];

const responseSchema = {
  type: "object",
  properties: {
    pageKind: {
      type: "string",
      description: "cover, toc, content, exercise, illustration, blank, or other",
    },
    layoutNotes: {
      type: "string",
      description: "One or two sentences on overall layout quality. Empty if fine.",
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ISSUE_TYPES },
          severity: { type: "string", enum: ["critical", "major", "minor"] },
          quote: {
            type: "string",
            description: "Exact printed text or a short visual description",
          },
          suggestion: { type: "string" },
          explanation: { type: "string" },
          box_2d: {
            type: "array",
            items: { type: "number" },
            description: "[ymin, xmin, ymax, xmax] normalized 0-1000",
          },
          confidence: { type: "number" },
        },
        required: ["type", "severity", "quote", "suggestion", "explanation", "box_2d"],
      },
    },
  },
  required: ["pageKind", "issues"],
};

// The Gemini API instructs: "use models/gemini-3.6-flash"
export const GEMINI_FAST = "gemini-3.6-flash";
export const GEMINI_QUALITY = "gemini-3.6-flash";
export const DEFAULT_MODEL = GEMINI_FAST;
export const QUALITY_MODEL = GEMINI_QUALITY;
export const FAST_MODEL = GEMINI_FAST;

// Multi-model fallback: try the selected model first, then the other 3.
function getAllFallbackCandidates(primaryModel) {
  const allModels = [
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
  ];
  const others = allModels.filter((m) => m !== primaryModel);
  // If primaryModel wasn't in the list, add it to the front anyway
  return [...new Set([primaryModel, ...others])];
}

export function currentProvider() {
  if (process.env.GEMINI_API_KEY) return "gemini";
  return null;
}

export function hasAnyKey() {
  return Boolean(process.env.GEMINI_API_KEY);
}

export function resolveModel(name) {
  const provider = currentProvider();
  if (provider === "xai") {
    const raw = String(name || process.env.XAI_MODEL || "grok-4.6").trim();
    if (!raw || raw.startsWith("gemini")) return process.env.XAI_MODEL || "grok-4.6";
    return raw;
  }
  const raw = String(name || process.env.GEMINI_MODEL || GEMINI_FAST).trim();
  if (!raw || raw.startsWith("grok")) return process.env.GEMINI_MODEL || GEMINI_FAST;
  return raw;
}

function thinkingConfig(model, explicitLevel) {
  const name = (model || "").toLowerCase();
  const level = (explicitLevel || process.env.GEMINI_THINKING_LEVEL || "low").toUpperCase();
  
  if (name.includes("gemini-3")) {
    return { thinkingLevel: level };
  }
  if (name.includes("gemini-2.5")) {
    return { thinkingBudget: 0 };
  }
  return {};
}

function buildPrompt({
  pageNumber,
  pageCount,
  language,
  bookType,
  classLevel = "",
  subject = "",
  textExtract,
  prevPageSnippet = "",
  nextPageSnippet = "",
  expectedUnit = "",
  expectedChapter = "",
  tocSummary = "",
  omitTextExtract = false,
}) {
  const langHint =
    language === "hindi"
      ? "The page is primarily Hindi (Devanagari). Check Hindi spelling, matras, anusvara, nukta, and grammar."
      : language === "english"
        ? "The page is primarily English."
        : language === "mixed"
          ? "The page mixes English and Hindi. Check both scripts thoroughly."
          : "The page may be English, Hindi (Devanagari), or mixed. Check every script that appears.";

  const typeHint =
    {
      textbook: "School textbook page. Check pedagogy, definitions, diagrams, and exercises.",
      workbook: "Workbook/exercise page. Check numbering, blanks, answer cues, and instructions.",
      story: "Story/reader page. Check dialogue punctuation, character consistency, and narrative grammar.",
      general: "General publication book page.",
    }[bookType] || "General print book page.";

  return `You are an expert senior editorial proofreader. Perform a careful, objective analysis of this page image (Page ${pageNumber} of ${pageCount}).

${typeHint} ${langHint}
${classLevel ? `Intended class/grade: ${classLevel}.` : ""}
${subject ? `Intended subject: ${subject}.` : ""}
${expectedChapter ? `Detected Chapter: "${expectedChapter}"` : ""}
${expectedUnit ? `Detected Unit: "${expectedUnit}"` : ""}
${tocSummary ? `TOC Index Context: ${tocSummary}` : ""}

Do NOT rewrite sentences just for stylistic preferences. Only flag objective errors, typos, or poor sentence flow that disrupts reading readability. Perform the following checks strictly as bullet points:

1. PAGE & STRUCTURE:
   - Check the printed page number in header/footer. Flag if it contradicts sequence for page ${pageNumber}, or is missing/duplicate.
   - Verify that the Unit/Chapter name displayed matches the chapter-unit hierarchy in the Index/TOC and aligns with the content explained.
   - Check footer symmetry (page number, book/class name, spacing) and inner design.

2. TYPOGRAPHY & VISUALS:
   - Validate font (style, size, colour) and Bold Text decisions.
   - Validate headings and subheadings for correct focus, relevance, proper hierarchy (H1/H2/H3), and strict sentence case.
   - Check image/diagram relevance to content, "God Images", QR code placement, and Icon Text Accurate Detection.
   - Verify OMR sheets and complex illustrations.
   - **CRITICAL VISUAL RULE**: If a heading has a visual font border, shadow, or stroke of a different color, the text might appear twice in the image extraction. DO NOT flag this as duplicate text or a repetition error.

3. CONTENT & LOGIC:
   - Look for logical contradictions, mathematical impossibilities, outdated information, or objective concept incorrectness.
   - Flag broken puzzle logic or inconsistent examples.
   - If "Learning Outcomes" or "Objectives" are present, verify they match the topics actually taught.
   - Check solved examples / activities for consistent formatting and sequential numbering (Example 1, Example 2...).

4. LINGUISTICS, FLOW & PUNCTUATION:
   - Check syntax, spelling (English/Hindi matras), natural transitions, fragments, and sentence flow.
   ${prevPageSnippet ? `* Previous page ended: "${prevPageSnippet.slice(-180)}"` : ""}
   ${nextPageSnippet ? `* Next page starts: "${nextPageSnippet.slice(0, 180)}"` : ""}
   - Verify sentence continuation across page boundaries.
   - Validate all punctuation marks (, . ? : ; ' " " () etc).
   - **STRICT HEADING COLON RULE**: NO space between a heading/label and its colon (e.g. "Heading:" is correct; "Heading :" is an ERROR).
   - **STRICT CONJUNCTION COLON RULE**: NO colon before "and" or conjunctions in lists ("rat, cat and lion" is correct; "rat, cat: and lion" is an ERROR).
   - Avoid Repetitive Instruction of an Issue (Single Error Multiple Suggestion).
   - Check all exercises and test/modal papers according to content alignment.

CRITICAL OUTPUT RULES:
- Return valid JSON matching the schema.
- NEVER group multiple distinct errors into a single issue! Each specific error MUST have its own independent JSON object.
- EXHAUSTIVE EXTRACTION: You MUST find and list EVERY SINGLE legitimate error on the page. Do not stop after finding just a few. If there are 10 errors, you must return 10 distinct objects.
- For each real issue, provide the EXACT quote (only the specific sentence or phrase with the error), a clear suggestion, a brief explanation, and a tight box_2d [ymin, xmin, ymax, xmax] (0-1000).
- If the page is clean, return issues: [].

${omitTextExtract ? "" : `Visible page text extract:\n${(textExtract || "").slice(0, 2200)}`}
`;
}

function clampBox(box) {
  const nums = Array.isArray(box) ? box.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
  let ymin = 0;
  let xmin = 0;
  let ymax = 1000;
  let xmax = 1000;
  if (nums.length >= 4) {
    ymin = nums[0];
    xmin = nums[1];
    ymax = nums[2];
    xmax = nums[3];
  }
  ymin = Math.min(1000, Math.max(0, ymin));
  xmin = Math.min(1000, Math.max(0, xmin));
  ymax = Math.min(1000, Math.max(0, ymax));
  xmax = Math.min(1000, Math.max(0, xmax));
  if (ymax <= ymin) ymax = Math.min(1000, ymin + 30);
  if (xmax <= xmin) xmax = Math.min(1000, xmin + 40);
  return { ymin, xmin, ymax, xmax };
}

function normalizeIssues(raw) {
  const list = Array.isArray(raw?.issues) ? raw.issues : [];
  return list
    .map((item) => {
      const type = ISSUE_TYPES.includes(item?.type) ? item.type : "other";
      const severity = ["critical", "major", "minor"].includes(item?.severity)
        ? item.severity
        : "major";
      const quote = String(item?.quote || "").trim();
      const suggestion = String(item?.suggestion || "").trim();
      const explanation = String(item?.explanation || "").trim();
      if (!quote && !explanation) return null;
      return {
        uid: crypto.randomUUID(),
        type,
        severity,
        quote,
        suggestion,
        explanation,
        box: clampBox(item?.box_2d),
        confidence: Math.min(1, Math.max(0, Number(item?.confidence) || 0.7)),
        status: "open",
      };
    })
    .filter(Boolean);
}

export function getClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is missing. Add it to the .env file.");
  }
  return new GoogleGenAI({ apiKey: key });
}

function getXaiClient() {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error("XAI_API_KEY is missing. Add it to the .env file.");
  return new OpenAI({
    apiKey: key,
    baseURL: "https://api.x.ai/v1",
    timeout: 360000,
  });
}

const xaiSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    pageKind: {
      type: "string",
      description: "cover, toc, content, exercise, illustration, blank, or other",
    },
    layoutNotes: {
      type: "string",
      description: "One or two sentences on overall layout quality. Empty if fine.",
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ISSUE_TYPES },
          severity: { type: "string", enum: ["critical", "major", "minor"] },
          quote: { type: "string" },
          suggestion: { type: "string" },
          explanation: { type: "string" },
          box_2d: {
            type: "array",
            items: { type: "number" },
            description: "[ymin, xmin, ymax, xmax] normalized 0-1000",
          },
          confidence: { type: "number" },
        },
        required: [
          "type",
          "severity",
          "quote",
          "suggestion",
          "explanation",
          "box_2d",
          "confidence",
        ],
      },
    },
  },
  required: ["pageKind", "layoutNotes", "issues"],
};

function parseModelJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { pageKind: "content", issues: [] };
  }
}

  async function analyzeWithXai({ b64, mimeType, prompt, model }) {
  const client = getXaiClient();
  const usedModel = model.startsWith("gemini") ? "grok-4.6" : model;
  const response = await client.responses.create({
    model: usedModel,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          {
            type: "input_image",
            image_url: `data:${mimeType || 'image/jpeg'};base64,${b64}`,
            detail: "high",
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "page_proof",
        schema: xaiSchema,
        strict: true,
      },
    },
  });
  return {
    parsed: parseModelJson(response.output_text || ""),
    tokensUsed: response.usage?.total_tokens || 0,
  };
}

function mergeWithLinterIssues(aiIssues, linterIssues) {
  const finalIssues = [...aiIssues];
  for (const lintItem of linterIssues) {
    const cleanLintQuote = (lintItem.quote || "").toLowerCase().replace(/\s+/g, "");
    const alreadyFound = finalIssues.some((ai) => {
      const cleanAiQuote = (ai.quote || "").toLowerCase().replace(/\s+/g, "");
      return (
        (cleanLintQuote && cleanAiQuote && (cleanAiQuote.includes(cleanLintQuote) || cleanLintQuote.includes(cleanAiQuote))) ||
        (ai.type === lintItem.type && ai.suggestion === lintItem.suggestion)
      );
    });
    if (!alreadyFound) {
      finalIssues.push(lintItem);
    }
  }
  return finalIssues;
}

export async function analyzePageImage({
  pdfBytes,
  imagePath,
  pageNumber,
  pageCount,
  language,
  bookType,
  classLevel = "",
  subject = "",
  textExtract,
  prevPageSnippet = "",
  nextPageSnippet = "",
  expectedUnit = "",
  expectedChapter = "",
  tocSummary = "",
  model,
  thinkingLevel,
}) {
  let inlineDataPart;
  if (pdfBytes) {
    inlineDataPart = {
      inlineData: {
        data: Buffer.from(pdfBytes).toString("base64"),
        mimeType: "application/pdf",
      },
    };
  } else {
    const jpeg = await fs.readFile(imagePath);
    inlineDataPart = {
      inlineData: {
        data: jpeg.toString("base64"),
        mimeType: "image/jpeg",
      },
    };
  }
  
  const usedModel = resolveModel(model);
  const prompt = buildPrompt({
    pageNumber,
    pageCount,
    language,
    bookType,
    classLevel,
    subject,
    textExtract,
    prevPageSnippet,
    nextPageSnippet,
    expectedUnit,
    expectedChapter,
    tocSummary,
    omitTextExtract: Boolean(pdfBytes), // Gemini reads native PDF text perfectly, don't duplicate it.
  });

  // Run deterministic typographical / sequence linter
  const linterIssues = lintPageText({
    text: textExtract || "",
    pageNumber,
    pageCount,
    expectedPageNumber: pageNumber,
    prevPageText: prevPageSnippet,
    currentChapter: expectedChapter,
    currentUnit: expectedUnit,
  });

  if (currentProvider() === "xai") {
    await rateLimit();
    // XAI does not support native application/pdf, so we MUST fall back to the JPEG.
    // If we only have pdfBytes, we still need to load the JPEG from disk.
    const jpegData = await fs.readFile(imagePath);
    const result = await analyzeWithXai({ 
      b64: jpegData.toString("base64"), 
      mimeType: "image/jpeg",
      prompt, 
      model: usedModel 
    });
    const aiIssues = normalizeIssues(result.parsed);
    return {
      pageKind: String(result.parsed.pageKind || "content"),
      layoutNotes: String(result.parsed.layoutNotes || ""),
      issues: mergeWithLinterIssues(aiIssues, linterIssues),
      tokensUsed: result.tokensUsed,
    };
  }

  const ai = getClient();
  const level = thinkingLevel || process.env.GEMINI_THINKING_LEVEL || "low";
  const skipTemperature = /gemini-3/.test(usedModel);

  const contents = [
    {
      role: "user",
      parts: [
        { text: prompt },
        inlineDataPart,
      ],
    },
  ];
  const config = {
    responseMimeType: "application/json",
    responseSchema,
    thinkingConfig: thinkingConfig(usedModel, level),
    // Bound the paid output surface per page. This includes thinking tokens on
    // Gemini 3 and prevents an unexpectedly verbose page from running away.
    maxOutputTokens: Math.max(512, Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048)),
  };
  if (!skipTemperature) config.temperature = 0.1;

  const response = await generateWithFallback(ai, usedModel, contents, config, level);
  const parsed = parseModelJson(response.text || "");
  const usage = response.usageMetadata || {};
  const aiIssues = normalizeIssues(parsed);

  return {
    pageKind: String(parsed.pageKind || "content"),
    layoutNotes: String(parsed.layoutNotes || ""),
    issues: mergeWithLinterIssues(aiIssues, linterIssues),
    tokensUsed:
      (usage.totalTokenCount || 0) ||
      (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0),
  };
}

export function friendlyError(raw) {
  const msg = String(raw || "");
  if (!msg) return "";
  if (/internal error/i.test(msg)) {
    return "Gemini hit an internal error. Retrying…";
  }
  if (
    msg.includes("DEADLINE") ||
    msg.includes("504") ||
    msg.includes("timed out") ||
    msg.includes("aborted")
  ) {
    return "Gemini timed out. Retrying this page…";
  }
  if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
    return "Gemini is busy. Waiting, then retrying…";
  }
  const trimmed = msg.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed.error?.message || "Analysis failed";
    } catch {
      return "Analysis failed";
    }
  }
  return msg.length > 140 ? `${msg.slice(0, 140)}…` : msg;
}

function isDeadModelError(err) {
  const msg = String(err?.message || err);
  return (
    msg.includes("404") ||
    msg.includes("NOT_FOUND") ||
    msg.includes("no longer available") ||
    (msg.includes("free_tier") && msg.includes("limit: 0"))
  );
}

// 403 / PERMISSION_DENIED = API key revoked or project blocked.
// This is FATAL — never retry, never fallback, never loop. Stop immediately.
function isFatalAuthError(err) {
  const msg = String(err?.message || err);
  return (
    (msg.includes("403") && msg.includes("PERMISSION_DENIED")) ||
    msg.includes("denied access") ||
    msg.includes("API key not valid") ||
    msg.includes("API_KEY_INVALID")
  );
}

function isRetryable(err) {
  const msg = String(err?.message || err);
  // Never retry fatal auth errors — they will never succeed and just burn cycles
  if (isFatalAuthError(err)) return false;
  return (
    !isDeadModelError(err) &&
    (msg.includes("429") ||
      msg.includes("503") ||
      msg.includes("504") ||
      msg.includes("DEADLINE") ||
      msg.includes("UNAVAILABLE") ||
      msg.includes("RESOURCE_EXHAUSTED") ||
      msg.includes("timed out") ||
      msg.includes("aborted") ||
      msg.includes("fetch failed") ||
      /internal error/i.test(msg) ||
      msg.includes("500"))
  );
}

async function generateWithFallback(ai, usedModel, contents, config, level) {
  // Stack quotas across up to 4 flash models
  const candidates = getAllFallbackCandidates(usedModel);
  let lastErr;
  for (let i = 0; i < candidates.length; i += 1) {
    const model = candidates[i];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const nextConfig = {
        ...config,
        thinkingConfig: thinkingConfig(model, level),
        abortSignal: controller.signal,
        httpOptions: { timeout: 60000 },
      };
      // gemini-3.x doesn't accept temperature
      if (/gemini-3/.test(model)) delete nextConfig.temperature;
      // Pace each actual Gemini request, including fallback attempts. Previously
      // the limiter was only reachable through the unused xAI branch.
      await rateLimit();
      const pending = ai.models.generateContent({ model, contents, config: nextConfig });
      // The SDK receives the abort signal above. Do not race it with a second
      // timer: a race can start the fallback while the original network call
      // is still alive, producing concurrent duplicate requests.
      return await pending;
    } catch (err) {
      lastErr = err;
      let msg = String(err?.message || err);

      // FATAL: 403/PERMISSION_DENIED — stop immediately, do not fallback, do not retry
      if (isFatalAuthError(err)) {
        console.error(`FATAL: API key blocked or project denied access. Model: ${model}. Fix your GEMINI_API_KEY.`);
        throw new Error("YOUR PROJECT HAS BEEN DENIED ACCESS. PLEASE CONTACT SUPPORT.");
      }

      if (err?.name === "AbortError" || msg.includes("aborted") || msg.includes("timeout")) {
        lastErr = new Error(`Gemini timed out on ${model}`);
        msg = lastErr.message; // Update msg so the fallback condition catches it!
      }
      
      const shouldFallback = i < candidates.length - 1;
      // Fall back on dead-model errors, timeouts, overloads, or rate limits
      if (shouldFallback && (
        isDeadModelError(err) ||
        msg.includes("timed out") ||
        msg.includes("503") ||
        msg.includes("504") ||
        msg.includes("DEADLINE") ||
        msg.includes("UNAVAILABLE") ||
        msg.includes("429") ||
        msg.includes("RESOURCE_EXHAUSTED")
      )) {
        console.warn(`Model ${model} failed (${msg.slice(0, 80)}), trying fallback: ${candidates[i + 1]}`);
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastGeminiAt = 0;

async function rateLimit() {
  const gap = Number(process.env.GEMINI_MIN_GAP_MS || 13000);
  const wait = gap - (Date.now() - lastGeminiAt);
  if (wait > 0) {
    console.log(`rate-limit wait ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
  lastGeminiAt = Date.now();
}

function suggestedWaitMs(err) {
  const msg = String(err?.message || err);
  const m = msg.match(/Please retry in ([\d.]+)s/i);
  if (m) return Math.ceil(Number(m[1]) * 1000) + 1000;
  if (msg.includes("DEADLINE") || msg.includes("504") || msg.includes("timed out")) {
    return 8000; // increased from 4000 — give Gemini more time to recover
  }
  if (msg.includes("503") || msg.includes("UNAVAILABLE")) {
    return 10000;
  }
  return 8000;
}

export async function withRetry(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = String(err?.message || err);
      if (!isRetryable(err) || i === attempts - 1) throw err;
      const wait = suggestedWaitMs(err);
      console.warn(`retry ${i + 1}/${attempts} in ${Math.round(wait / 1000)}s: ${msg.slice(0, 120)}`);
      await sleep(wait);
    }
  }
  throw last;
}
