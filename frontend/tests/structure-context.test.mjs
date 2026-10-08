import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source = await fs.readFile(new URL("../src/server/services/structure.js", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, allowJs: true },
});
const module = { exports: {} };
vm.runInNewContext(outputText, {
  module, exports: module.exports,
  require(name) {
    assert.equal(name, "./pdf.js");
    return { extractPageText: async (doc, page) => doc.text?.[page] || "" };
  },
});
const { extractBookStructure, getPageContextFromStructure } = module.exports;

test("printed TOC page labels never become unverified PDF chapter positions", async () => {
  const structure = await extractBookStructure({
    numPages: 25, getOutline: async () => [],
    text: { 3: "Contents Chapter 1: Patterns ... 1 Chapter 2: Reasoning ... 10" },
  });
  assert.equal(structure.chapters.length, 2);
  assert.equal(structure.chapters[0].page, null);
  assert.equal(structure.chapters[0].printedPage, 1);
  const context = getPageContextFromStructure(structure, 4);
  assert.equal(context.expectedChapter, "");
  assert.equal(context.expectedUnit, "");
  assert.match(context.tocSummary, /Patterns \(printed pg 1; PDF position unverified\)/);
});

test("legacy stored chapter maps abstain when PDF numbering provenance is absent", () => {
  const context = getPageContextFromStructure({
    chapters: [{ number: 1, name: "Patterns", page: 1, unit: "Unit 1" }],
    toc: [{ title: "Chapter 1: Patterns", page: 1 }],
  }, 4);
  assert.equal(context.expectedChapter, "");
  assert.equal(context.expectedUnit, "");
  assert.match(context.tocSummary, /PDF position unverified/);
});

test("nested native bookmarks resolve real PDF pages and preserve their unit", async () => {
  const structure = await extractBookStructure({
    numPages: 20,
    getOutline: async () => [{ title: "Unit 1: Thinking", dest: [3], items: [
      { title: "Chapter 1: Patterns", dest: "patterns" },
      { title: "Chapter 2: Reasoning", dest: [{ num: 42, gen: 0 }] },
    ] }],
    getDestination: async () => [3],
    getPageIndex: async () => 9,
  });
  assert.equal(structure.chapters.length, 2);
  assert.equal(getPageContextFromStructure(structure, 3).expectedChapter, "");
  assert.equal(getPageContextFromStructure(structure, 4).expectedChapter, "Chapter 1: Patterns");
  assert.equal(getPageContextFromStructure(structure, 10).expectedChapter, "Chapter 2: Reasoning");
  assert.equal(getPageContextFromStructure(structure, 10).expectedUnit, "Unit 1: Thinking");
  assert.match(getPageContextFromStructure(structure, 10).tocSummary, /PDF pg 4/);
});

test("zero-based bookmark page zero is valid and unresolved bookmarks still inform TOC", async () => {
  const structure = await extractBookStructure({
    numPages: 3,
    getOutline: async () => [
      { title: "Chapter 1: Patterns", dest: [0] },
      { title: "Appendix", dest: "missing" },
    ],
    getDestination: async () => null,
  });
  assert.equal(getPageContextFromStructure(structure, 1).expectedChapter, "Chapter 1: Patterns");
  assert.match(getPageContextFromStructure({ toc: structure.toc, chapters: [] }, 2).tocSummary, /Appendix/);
});

test("front-matter exercises are not parsed as a table of contents", async () => {
  const structure = await extractBookStructure({
    numPages: 10, getOutline: async () => [],
    text: { 4: "1. Find the missing number 5 2. Complete the pattern 9" },
  });
  assert.equal(structure.chapters.length, 0);
  assert.equal(structure.toc.length, 0);
});
