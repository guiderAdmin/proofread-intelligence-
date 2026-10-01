import crypto from "crypto";

/**
 * Deterministic linter that scans extracted page text for exact typographical,
 * punctuation, heading colon, conjunction colon, and sequence errors.
 */

export function lintPageText({
  text = "",
  pageNumber = 1,
  pageCount = 1,
  expectedPageNumber = pageNumber,
  prevPageText = "",
  currentChapter = "",
  currentUnit = "",
  toc = [],
}) {
  const issues = [];
  if (!text || typeof text !== "string") return issues;

  const fullClean = text.replace(/\s+/g, " ").trim();

  // -------------------------------------------------------------
  // Rule 1: Heading Colon Rule
  // "there is no space between heading and colon for example (heading:- )"
  // Flag: "Heading :", "Heading :-", "Title :", "Note :", etc.
  // -------------------------------------------------------------
  // Look for words/phrases followed by whitespace before a colon or colon-dash
  const headingColonRegex = /(?:^|[\n.!?])\s*([A-Za-z0-9\s()]{2,45}?)\s+(:|:-|:—)\s*/g;
  let m;
  while ((m = headingColonRegex.exec(text)) !== null) {
    const rawMatch = m[0].trim();
    const headingText = m[1].trim();
    const punctuation = m[2]; // ':' or ':-'
    // Skip if it looks like a normal sentence time "10 : 30" or ratio "1 : 2"
    if (/^\d+\s*:\s*\d+$/.test(rawMatch)) continue;
    if (headingText && !/^(http|https|e\.g|i\.e)$/i.test(headingText)) {
      const fixedHeading = `${headingText}${punctuation}`;
      issues.push({
        uid: crypto.randomUUID(),
        type: "punctuation",
        severity: "major",
        quote: `${headingText} ${punctuation}`,
        suggestion: `${fixedHeading} `,
        explanation: `Remove the space before the colon in the heading. In standard publishing, there should be no space between the heading text and the colon (e.g. write '${fixedHeading}' instead of '${headingText} ${punctuation}').`,
        box: { ymin: 40, xmin: 40, ymax: 200, xmax: 960 },
        confidence: 0.98,
        status: "open",
      });
    }
  }

  // -------------------------------------------------------------
  // Rule 2: Conjunction Colon Rule
  // "there should be no colon before the and for example (rat,cat and lion ) this is correct way"
  // Flag: "rat: and lion", "cat, dog: and fish", "item: and item"
  // -------------------------------------------------------------
  const colonBeforeAndRegex = /([A-Za-z0-9]+)\s*:\s+(and|or|as well as)\b/gi;
  while ((m = colonBeforeAndRegex.exec(text)) !== null) {
    const prevWord = m[1];
    const conjunction = m[2];
    issues.push({
      uid: crypto.randomUUID(),
      type: "punctuation",
      severity: "major",
      quote: `${prevWord}: ${conjunction}`,
      suggestion: `${prevWord} ${conjunction}`,
      explanation: `Remove the colon before '${conjunction}'. In a series/list or sentence (such as 'rat, cat and lion'), conjunctions should not be preceded by a colon.`,
      box: { ymin: 150, xmin: 50, ymax: 850, xmax: 950 },
      confidence: 0.96,
      status: "open",
    });
  }

  // -------------------------------------------------------------
  // Rule 3: Page Numbering Sequencing Check
  // Check if text has a printed page number that contradicts the expected page sequence
  // -------------------------------------------------------------
  const pageNumMatches = [];
  const pageLabelRegex = /\b(?:Page|Pg\.?)\s*(\d+)\b/gi;
  while ((m = pageLabelRegex.exec(text)) !== null) {
    pageNumMatches.push({ foundNum: parseInt(m[1], 10), quote: m[0] });
  }

  // Also check last token if it's purely a page number
  const tokens = fullClean.split(" ");
  const lastToken = tokens[tokens.length - 1];
  if (/^\d{1,4}$/.test(lastToken)) {
    const num = parseInt(lastToken, 10);
    if (num > 0 && num <= pageCount + 50) {
      pageNumMatches.push({ foundNum: num, quote: `[Page footer: ${num}]` });
    }
  }

  for (const pm of pageNumMatches) {
    if (expectedPageNumber && Math.abs(pm.foundNum - expectedPageNumber) > 15) {
      issues.push({
        uid: crypto.randomUUID(),
        type: "page_number",
        severity: "major",
        quote: pm.quote,
        suggestion: `Page ${expectedPageNumber}`,
        explanation: `Printed page number (${pm.foundNum}) appears out of sequence with expected document page (${expectedPageNumber}). Verify page sequencing in the layout.`,
        box: { ymin: 900, xmin: 400, ymax: 990, xmax: 600 },
        confidence: 0.85,
        status: "open",
      });
      break;
    }
  }

  // -------------------------------------------------------------
  // Rule 4: Example Numbering Sequence
  // Check for duplicate or skipping "Example X" on the same page
  // -------------------------------------------------------------
  const exampleRegex = /\b(?:Example|Solved Example|Illustration|Activity)\s*(\d+)\b/gi;
  const exampleNums = [];
  while ((m = exampleRegex.exec(text)) !== null) {
    exampleNums.push({ num: parseInt(m[1], 10), quote: m[0] });
  }
  for (let i = 1; i < exampleNums.length; i += 1) {
    const prev = exampleNums[i - 1].num;
    const curr = exampleNums[i].num;
    if (curr === prev) {
      issues.push({
        uid: crypto.randomUUID(),
        type: "examples",
        severity: "major",
        quote: exampleNums[i].quote,
        suggestion: `Example ${prev + 1}`,
        explanation: `Duplicate example numbering detected: '${exampleNums[i].quote}' repeats previous '${exampleNums[i - 1].quote}'. Example numbering should follow a sequential pattern.`,
        box: { ymin: 200, xmin: 50, ymax: 800, xmax: 950 },
        confidence: 0.92,
        status: "open",
      });
    } else if (curr > prev + 1) {
      issues.push({
        uid: crypto.randomUUID(),
        type: "examples",
        severity: "minor",
        quote: exampleNums[i].quote,
        suggestion: `Example ${prev + 1}`,
        explanation: `Example numbering jumps from Example ${prev} directly to ${exampleNums[i].quote}. Verify that no intermediate example was omitted.`,
        box: { ymin: 200, xmin: 50, ymax: 800, xmax: 950 },
        confidence: 0.88,
        status: "open",
      });
    }
  }

  // -------------------------------------------------------------
  // Rule 5: Double Colons or Malformed Colons
  // Flag "::" or " - :"
  // -------------------------------------------------------------
  const malformedColonRegex = /([A-Za-z0-9]+)\s*(::|\s+-\s+:)\s*/g;
  while ((m = malformedColonRegex.exec(text)) !== null) {
    issues.push({
      uid: crypto.randomUUID(),
      type: "punctuation",
      severity: "minor",
      quote: m[0].trim(),
      suggestion: `${m[1]}:`,
      explanation: `Malformed colon punctuation detected '${m[0].trim()}'. Replace with a standard single colon '${m[1]}:'.`,
      box: { ymin: 100, xmin: 50, ymax: 900, xmax: 950 },
      confidence: 0.95,
      status: "open",
    });
  }

  return issues;
}
