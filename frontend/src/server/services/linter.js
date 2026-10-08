import crypto from "crypto";

/**
 * Deterministic linter that scans extracted page text for exact typographical,
 * punctuation, heading colon, conjunction colon, and sequence errors.
 */

export function lintPageText({
  text = "",
  pageNumber = 1,
  pageCount = 1,
  expectedPageNumber,
  prevPageText = "",
  currentChapter = "",
  currentUnit = "",
  toc = [],
}) {
  const issues = [];
  if (!text || typeof text !== "string") return issues;

  const fullClean = text.replace(/\s+/g, " ").trim();
  const addIssue = (issue, textStart, textEnd) => issues.push({
    ...issue,
    // Linter guesses used to be large invented page rectangles. Only a text
    // match or OCR measurement can establish the location of these findings.
    box: { ymin: 0, xmin: 0, ymax: 1000, xmax: 1000 },
    boxSource: "unverified",
    source: "linter",
    ...(Number.isInteger(textStart) ? { textStart, textEnd } : {}),
  });

  // -------------------------------------------------------------
  // Rule 1: Heading Colon Rule
  // "there is no space between heading and colon for example (heading:- )"
  // Flag: "Heading :", "Heading :-", "Title :", "Note :", etc.
  // -------------------------------------------------------------
  // Look for words/phrases followed by whitespace before a colon or colon-dash
  const headingColonRegex = /(?:^|[\n.!?])[ \t]*([A-Za-z0-9 \t()]{2,45}?)[ \t]+(:-|:—|:)[ \t]*/g;
  let m;
  while ((m = headingColonRegex.exec(text)) !== null) {
    const rawMatch = m[0].trim();
    const headingText = m[1].trim();
    const punctuation = m[2]; // ':' or ':-'
    // Skip if it looks like a normal sentence time "10 : 30" or ratio "1 : 2"
    if (/^\d+$/.test(headingText) && /^\d/.test(text.slice(m.index + m[0].length))) continue;
    if (headingText && !/^(http|https|e\.g|i\.e)$/i.test(headingText)) {
      const fixedHeading = `${headingText}${punctuation}`;
      const textStart = m.index + m[0].indexOf(headingText);
      const textEnd = m.index + m[0].lastIndexOf(punctuation) + punctuation.length;
      addIssue({
        uid: crypto.randomUUID(),
        type: "punctuation",
        severity: "major",
        quote: text.slice(textStart, textEnd),
        suggestion: `${fixedHeading} `,
        explanation: `Remove the space before the colon in the heading. In standard publishing, there should be no space between the heading text and the colon (e.g. write '${fixedHeading}' instead of '${headingText} ${punctuation}').`,
        box: { ymin: 40, xmin: 40, ymax: 200, xmax: 960 },
        confidence: 0.98,
        status: "open",
      }, textStart, textEnd);
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
    addIssue({
      uid: crypto.randomUUID(),
      type: "punctuation",
      severity: "major",
      quote: m[0],
      suggestion: `${prevWord} ${conjunction}`,
      explanation: `Remove the colon before '${conjunction}'. In a series/list or sentence (such as 'rat, cat and lion'), conjunctions should not be preceded by a colon.`,
      box: { ymin: 150, xmin: 50, ymax: 850, xmax: 950 },
      confidence: 0.96,
      status: "open",
    }, m.index, m.index + m[0].length);
  }

  // -------------------------------------------------------------
  // Rule 3: Page Numbering Sequencing Check
  // Check if text has a printed page number that contradicts the expected page sequence
  // -------------------------------------------------------------
  const pageNumMatches = [];
  const pageLabelRegex = /\b(?:Page|Pg\.?)\s*(\d+)\b/gi;
  while ((m = pageLabelRegex.exec(text)) !== null) {
    pageNumMatches.push({ foundNum: parseInt(m[1], 10), quote: m[0], textStart: m.index });
  }

  // Also check last token if it's purely a page number
  const tokens = fullClean.split(" ");
  const lastToken = tokens[tokens.length - 1];
  if (/^\d{1,4}$/.test(lastToken)) {
    const num = parseInt(lastToken, 10);
    if (num > 0 && num <= pageCount + 50) {
      pageNumMatches.push({ foundNum: num, quote: lastToken, textStart: text.lastIndexOf(lastToken) });
    }
  }

  for (const pm of pageNumMatches) {
    if (expectedPageNumber && Math.abs(pm.foundNum - expectedPageNumber) > 15) {
      addIssue({
        uid: crypto.randomUUID(),
        type: "page_number",
        severity: "major",
        quote: pm.quote,
        suggestion: `Page ${expectedPageNumber}`,
        explanation: `Printed page number (${pm.foundNum}) appears out of sequence with expected document page (${expectedPageNumber}). Verify page sequencing in the layout.`,
        box: { ymin: 900, xmin: 400, ymax: 990, xmax: 600 },
        confidence: 0.85,
        status: "open",
      }, pm.textStart, pm.textStart + pm.quote.length);
      break;
    }
  }

  // -------------------------------------------------------------
  // Rule 4: Example Numbering Sequence
  // Check for duplicate or skipping "Example X" on the same page
  // -------------------------------------------------------------
  const exampleRegex = /\b(Solved Example|Example|Illustration|Activity)\s*(\d+)\b/gi;
  const exampleNums = [];
  while ((m = exampleRegex.exec(text)) !== null) {
    exampleNums.push({ label: m[1].toLowerCase(), num: parseInt(m[2], 10), quote: m[0], textStart: m.index });
  }
  const previousExample = new Map();
  for (const example of exampleNums) {
    const previous = previousExample.get(example.label);
    previousExample.set(example.label, example);
    if (!previous) continue;
    const prev = previous.num;
    const curr = example.num;
    if (curr === prev) {
      addIssue({
        uid: crypto.randomUUID(),
        type: "examples",
        severity: "major",
        quote: example.quote,
        suggestion: `${example.quote.replace(/\d+$/, "")}${prev + 1}`,
        explanation: `Duplicate example numbering detected: '${example.quote}' repeats previous '${previous.quote}'. Example numbering should follow a sequential pattern.`,
        box: { ymin: 200, xmin: 50, ymax: 800, xmax: 950 },
        confidence: 0.92,
        status: "open",
      }, example.textStart, example.textStart + example.quote.length);
    } else if (curr > prev + 1) {
      addIssue({
        uid: crypto.randomUUID(),
        type: "examples",
        severity: "minor",
        quote: example.quote,
        suggestion: `${example.quote.replace(/\d+$/, "")}${prev + 1}`,
        explanation: `Example numbering jumps from ${previous.quote} directly to ${example.quote}. Verify that no intermediate example was omitted.`,
        box: { ymin: 200, xmin: 50, ymax: 800, xmax: 950 },
        confidence: 0.88,
        status: "open",
      }, example.textStart, example.textStart + example.quote.length);
    }
  }

  // -------------------------------------------------------------
  // Rule 5: Double Colons or Malformed Colons
  // Flag "::" or " - :"
  // -------------------------------------------------------------
  const malformedColonRegex = /([A-Za-z0-9]+)\s*(::|\s+-\s+:)\s*/g;
  while ((m = malformedColonRegex.exec(text)) !== null) {
    addIssue({
      uid: crypto.randomUUID(),
      type: "punctuation",
      severity: "minor",
      quote: m[0].trim(),
      suggestion: `${m[1]}:`,
      explanation: `Malformed colon punctuation detected '${m[0].trim()}'. Replace with a standard single colon '${m[1]}:'.`,
      box: { ymin: 100, xmin: 50, ymax: 900, xmax: 950 },
      confidence: 0.95,
      status: "open",
    }, m.index, m.index + m[0].trimEnd().length);
  }

  // Modal verbs take a lowercase verb in ordinary mid-sentence text. Enumerate
  // every occurrence, including repeated captions on the same page.
  const modalCapitalRegex = /\b(will|shall|would|could|should|must|may|might|can)\s+(Complete)\b/g;
  while ((m = modalCapitalRegex.exec(text)) !== null) {
    addIssue({
      uid: crypto.randomUUID(), type: "typography", severity: "minor",
      quote: m[0], suggestion: m[0].replace(/Complete$/, "complete"),
      explanation: "The verb 'complete' follows a modal verb mid-sentence and should start with a lowercase letter.",
      confidence: 0.98, status: "open",
    }, m.index, m.index + m[0].length);
  }

  return issues;
}
