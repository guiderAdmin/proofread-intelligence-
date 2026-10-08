import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import Book from "../src/server/models/Book.js";
import Page from "../src/server/models/Page.js";
import {structureFromEvidence,localChapterContext} from "../feature/chapter-proofreader/server/index-evidence.js";
import {lintUnitLabels} from "../src/server/services/unit-label-checks.js";
import {lintAlphabetSteps} from "../src/server/services/alphabet-checks.js";
import {hasSubstantialNativeEvidence,snapIssuesToLayout} from "../src/server/services/pdf.js";
import {mergeDetectedIssues} from "../src/server/services/issue-reconciliation.js";
import {prepareEvidencePage,claimBatch} from "../src/server/services/queue.js";
const fixture=async n=>JSON.parse(await fs.readFile(new URL(`./fixtures/chapter-page${n}.json`,import.meta.url),"utf8"));

test("real OCR contents columns and opener give observed chapter boundaries, not printed page offsets",async()=>{
  const contents=await fixture(1),opener=await fixture(2);
  const pages=[contents,opener].map((e,i)=>({pageNumber:i+1,structuredText:e.structuredText,textLayout:e.layoutItems,evidenceIndexed:true}));
  let structure=structureFromEvidence({},pages,9);
  assert.equal(structure.chapters.length,2);
  assert.equal(structure.chapters[0].name,"Front matter");
  const chapter=structure.chapters[1];
  assert.equal(chapter.name,"Patterns");assert.equal(chapter.unit,"Unit 1: Patterns Recognition");
  assert.equal(chapter.confidence,.95);assert.equal(chapter.startPage,2);assert.equal(chapter.endPage,9);
  const toc=structure.toc.find(t=>t.title==="Patterns");assert.equal(toc.printedPage,5);assert.equal(toc.page,null);
  assert.equal(structure.pageMap[3],chapter.chapterKey);
  // Running header on the next page must not create another chapter.
  structure=structureFromEvidence(structure,[...pages,{...pages[1],pageNumber:3}],9);
  assert.equal(structure.chapters.length,2);assert.equal(structure.chapters[1].startPage,2);
  const context=localChapterContext(chapter,pages,3);assert.match(context,/1\/8 chapter pages/);assert.match(context,/PARTIAL CONTEXT/);
});

test("the repeated compound unit label is corrected on both pages without changing the valid chapter title",async()=>{
  for(const n of [1,2]) {
    const evidence=await fixture(n),issues=lintUnitLabels(evidence.layoutItems);
    assert.equal(issues.length,1);assert.equal(issues[0].quote,"Patterns Recognition");
    assert.equal(issues[0].suggestion,"Pattern Recognition");assert.equal(issues[0].boxSource,"ocr_text");
    assert.ok(issues[0].box.ymin<190);assert.equal(issues.some(i=>i.quote==="Patterns"),false);
  }
  const e=await fixture(2);assert.equal(lintUnitLabels(e.layoutItems.map(w=>w.str==="Patterns"?{...w,str:"Pattern"}:w)).length,0);
});

test("a native calendar layer cannot prevent full-page OCR",()=>{
  const labels="SUN MON TUE WED THU FRI SAT 27 28 29 30";
  assert.equal(hasSubstantialNativeEvidence(labels,Array.from({length:30},()=>({str:"SUN"}))),false);
  assert.equal(hasSubstantialNativeEvidence("native paragraph ".repeat(30),Array.from({length:30},()=>({str:"paragraph"}))),true);
});

test("an earlier unlocated +1 finding is grounded at both corroborated arrows and keeps its review decision",async()=>{
  const evidence=await fixture(3);
  const issues=[{uid:"original-arrow",type:"inconsistency",quote:"+1",suggestion:"−1",status:"accepted",source:"ai",boxSource:"unverified",box:{xmin:680,xmax:708,ymin:250,ymax:270}}];
  snapIssuesToLayout(issues,evidence.layoutItems);
  assert.equal(issues.length,2);assert.equal(issues[0].uid,"original-arrow");assert.equal(issues[0].status,"accepted");
  assert.ok(issues.every(i=>i.boxSource==="ocr_text"));assert.ok(issues[0].box.xmin<issues[1].box.xmin);
  assert.deepEqual(issues.map(i=>i.textStart),[302,308]);
  snapIssuesToLayout(issues,evidence.layoutItems);assert.equal(issues.length,2);
  assert.equal(mergeDetectedIssues(issues,lintAlphabetSteps(evidence.layoutItems)).length,2);
});

test("ambiguous signed numbers without corroborating sequence evidence stay unverified",()=>{
  const items=[{str:"+1",xmin:100,ymin:100,xmax:120,ymax:115,textStart:0,textEnd:2,source:"pdf_text"},
    {str:"+1",xmin:500,ymin:100,xmax:520,ymax:115,textStart:3,textEnd:5,source:"pdf_text"}];
  const unknown=[{type:"number",quote:"+1",suggestion:"-1",boxSource:"ai",box:{xmin:0,ymin:0,xmax:1000,ymax:1000}}];
  snapIssuesToLayout(unknown,items);assert.equal(unknown.length,1);assert.equal(unknown[0].boxSource,"unverified");
  const near=[{type:"number",quote:"+1",suggestion:"-1",boxSource:"ai",box:{xmin:102,ymin:100,xmax:122,ymax:115}}];
  snapIssuesToLayout(near,items);assert.equal(near[0].textStart,0);assert.equal(near[0].boxSource,"pdf_text");
  const bare=[{type:"number",quote:"1",suggestion:"2",boxSource:"ai"}];snapIssuesToLayout(bare,items);assert.equal(bare[0].boxSource,"unverified");
});

test("durable evidence preparation preserves existing findings through a concurrent review update and makes no provider call",async t=>{
  const e=await fixture(3),book={_id:"book",pageCount:9,language:"english",filePath:"/must-not-open.pdf"};
  let page={_id:"page",bookId:"book",pageNumber:3,status:"processing",analysisRunId:"prepare",issueRevision:0,
    issues:[{uid:"old-arrow",type:"inconsistency",quote:"+1",suggestion:"-1",status:"open",boxSource:"unverified",source:"ai"}]};
  t.mock.method(globalThis,"fetch",async()=>{throw new Error("preparation cannot contact a paid provider");});
  t.mock.method(Page,"findOne",()=>({lean:async()=>structuredClone(page)}));
  let attempts=0;
  t.mock.method(Page,"findOneAndUpdate",async(filter,update)=>{
    if(attempts++===0){page.issues[0].status="accepted";page.issueRevision++;return null;}
    assert.equal(filter.issueRevision,page.issueRevision);assert.equal(update.$set.status,"pending");
    Object.assign(page,structuredClone(update.$set));page.issueRevision++;delete page.analysisRunId;return structuredClone(page);
  });
  const result=await prepareEvidencePage(page,book,{loadEvidence:async()=>({...e,text:e.layoutItems.map(w=>w.str).join(" "),source:"ocr_text"})});
  assert.equal(result.evidencePrepared,true);assert.equal(result.status,"pending");assert.equal(result.textLayout.length,e.layoutItems.length);
  const arrows=result.issues.filter(i=>i.quote==="+1");assert.equal(arrows.length,2);
  assert.equal(arrows.find(i=>i.uid==="old-arrow").status,"accepted");assert.ok(arrows.every(i=>i.boxSource==="ocr_text"));
});

test("a preparation claim finishes before a batch can claim any page AI review",async t=>{
  const book={_id:"book",status:"queued",pageCount:2};
  const pages=[{_id:"p1",bookId:"book",pageNumber:1,status:"pending",evidencePrepared:true,issues:[]},
    {_id:"p2",bookId:"book",pageNumber:2,status:"pending",evidencePrepared:false,issues:[]}];
  t.mock.method(Book,"find",()=>({select:async()=>[book]}));
  t.mock.method(Page,"distinct",async()=>["book"]);
  t.mock.method(Page,"exists",async filter=>pages.find(p=>p.status===filter.status && !p.evidencePrepared)||null);
  t.mock.method(Page,"findOneAndUpdate",async(filter,update)=>{
    const page=pages.find(p=>p.status==="pending" && (!filter.evidencePrepared || !p.evidencePrepared));
    if(!page)return null;Object.assign(page,update.$set);return structuredClone(page);
  });
  t.mock.method(Book,"updateMany",async()=>({}));t.mock.method(Book,"findById",async()=>book);
  t.mock.method(Page,"find",()=>({lean:async()=>structuredClone(pages)}));
  t.mock.method(Book,"findByIdAndUpdate",async(_id,update)=>({...book,progress:update[0].$set.progress.$literal}));
  const preparation=await claimBatch({bookId:"book",limit:8});assert.deepEqual(preparation.map(p=>p._id),["p2"]);
  assert.equal(pages[0].status,"pending");
  pages[1].status="pending";pages[1].evidencePrepared=true;
  const reviews=await claimBatch({bookId:"book",limit:8});assert.deepEqual(reviews.map(p=>p._id),["p1","p2"]);
});
