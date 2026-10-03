const BUILT_IN_PATTERNS = [
  /do not rewrite.*style/i,
  /only flag objective errors/i,
  /no space.*heading.*colon/i,
  /no colon.*before.*(?:and|conjunction)/i,
  /return.*exact quote/i,
  /check.*punctuation/i,
];

function normalized(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Compile user setup text into a compact, deduplicated instruction brief. */
export function compileProjectInstructions(raw) {
  const parts = String(raw || "")
    .replace(/[\u0000-\u001F]/g, " ")
    .split(/(?:\r?\n|(?<=[.!?])\s+)/)
    .map((item) => item.trim())
    .filter(Boolean);
  const seen = new Set();
  const accepted = [];
  let ignored = 0;
  for (const part of parts) {
    const key = normalized(part);
    if (!key || seen.has(key) || BUILT_IN_PATTERNS.some((pattern) => pattern.test(part))) {
      ignored += 1;
      continue;
    }
    seen.add(key);
    accepted.push(part.slice(0, 500));
  }
  return { text: accepted.join("\n").slice(0, 2000), ignoredCount: ignored };
}
