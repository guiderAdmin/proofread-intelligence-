import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import Book from "../src/server/models/Book.js";
import Page from "../src/server/models/Page.js";
import { enqueueBook } from "../src/server/services/queue.js";
import { partitionGroundedFindings } from "../src/server/services/finding-evidence.js";
import { lintPageText } from "../src/server/services/linter.js";

test("upload queues all pages without opening/indexing the entire PDF", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const book = new Book({title:"Scanned book",filePath:"/nonexistent-do-not-read.pdf",pageCount:99});
  t.mock.method(book,"save",async()=>book);
  let queued;
  t.mock.method(Page,"insertMany",async rows=>{queued=rows;});
  await enqueueBook(book);
  assert.equal(book.status,"queued");assert.equal(queued.length,99);
  assert.ok(queued.every(p=>p.status==="pending" && !p.evidenceIndexed));
});

test("unlocated OCR fragment cannot become an actionable colon correction",()=>{
  const fragment=lintPageText({text:"my a Se :"});
  assert.equal(fragment.length,1);
  const result=partitionGroundedFindings(fragment);
  assert.equal(result.verified.length,0);assert.equal(result.pending.length,1);
  const real=partitionGroundedFindings([{...fragment[0],quote:"Teacher :",boxSource:"ocr_text"}]);
  assert.equal(real.verified.length,1);
});

test("colon headings cannot stitch separate extraction lines into a fake quote",()=>{
  const issues=lintPageText({text:"my a\nSe :"});
  assert.equal(issues.some(i=>i.quote.includes("\n")),false);
});

test("visual reasoning findings survive language evidence filtering",()=>{
  const logical={type:"number",source:"ai",quote:"Which number?",boxSource:"ai"};
  const random={type:"grammar",source:"ai",quote:"not printed",boxSource:"unverified"};
  const result=partitionGroundedFindings([logical,random]);
  assert.deepEqual(result.verified,[logical]);assert.deepEqual(result.pending,[random]);
});

test("same-book SAGE refresh reuses the loaded PDF instead of fetching it",async()=>{
  const source=await fs.readFile(new URL("../src/components/ProofreaderFlow.tsx",import.meta.url),"utf8");
  assert.match(source,/const cachedFile = sameBook \? selectedFileRef.current\?\.rawFile/);
  assert.match(source,/if \(cachedFile\) \{\s*void refineIssues\(restoredIssues, cachedFile\);\s*\} else \{/);
  for(const name of ["stages/ReviewStage.tsx","system/PagesPreview.tsx"]) {
    const component=await fs.readFile(new URL(`../src/components/${name}`,import.meta.url),"utf8");
    assert.match(component,/\[selectedFile\?\.rawFile\]/);
  }
});

import { lintAlphabetSteps } from "../src/server/services/alphabet-checks.js";
import { snapIssuesToLayout } from "../src/server/services/pdf.js";
import { reconcileAnalysisIssues } from "../src/server/services/issue-reconciliation.js";

test("actual page 4 alphabet pattern flags both incorrect backward arrow labels",async()=>{
  const items=JSON.parse(await fs.readFile(new URL("./fixtures/alphabet-page4.json",import.meta.url),"utf8"));
  const issues=lintAlphabetSteps(items);
  assert.equal(issues.length,2);assert.deepEqual(issues.map(i=>[i.quote,i.suggestion]),[["+1","-1"],["+1","-1"]]);
  assert.ok(issues[0].box.xmin<issues[1].box.xmin);
  const positions=issues.map(i=>i.box.xmin);
  snapIssuesToLayout(issues,items);
  assert.deepEqual(issues.map(i=>i.box.xmin),positions);
  assert.ok(issues.every(i=>i.boxSource==="ocr_text"));
  const next=reconcileAnalysisIssues(issues,[]);
  assert.equal(next.length,2);assert.ok(next.every(i=>i.seenInLatestAnalysis===false));
  const fixed=items.map(w=>w.str==="+1"?{...w,str:"-1"}:w);
  assert.equal(lintAlphabetSteps(fixed).length,0);
  assert.equal(lintAlphabetSteps(items.filter(w=>w.str!=="backward")).length,0);
});
