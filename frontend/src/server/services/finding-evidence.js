/** Language corrections require measured printed text; visual/concept checks
 * may use an explicitly estimated image location instead. */
const languageTypes = new Set(["spelling", "grammar", "punctuation", "typography", "heading", "wording"]);
export function partitionGroundedFindings(issues) {
  const verified = [], pending = [];
  for (const issue of issues || []) {
    const measured = ["pdf_text", "ocr_text"].includes(issue.boxSource);
    const requiresText = issue.source === "linter" || languageTypes.has(issue.type);
    (requiresText && !measured ? pending : verified).push(issue);
  }
  return { verified, pending };
}
