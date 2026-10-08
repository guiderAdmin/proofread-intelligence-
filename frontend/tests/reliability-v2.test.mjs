import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { PDFDocument } from "pdf-lib";
import { extractPageEvidence,withPdf } from "../src/server/services/pdf.js";
import { createCanvas } from "@napi-rs/canvas";
import Page from "../src/server/models/Page.js";
import Book from "../src/server/models/Book.js";
import ChapterContext from "../feature/chapter-proofreader/server/ChapterContext.js";
import { refreshEvidenceIndex } from "../feature/chapter-proofreader/server/service.js";
import { compactIssues, referencedIssueNumbers, retrievePageContext, parseCompanionResponse } from "../feature/agentic-bot/server/context.js";
import { lintHeadingLayout } from "../src/server/services/heading-checks.js";
import { analyzePageOnce } from "../src/server/services/gemini.js";
import { reconcileAnalysisIssues } from "../src/server/services/issue-reconciliation.js";
import { findTextMatches, layoutTranscript } from "../src/lib/text-geometry.js";
import { structureFromEvidence, localChapterContext } from "../feature/chapter-proofreader/server/index-evidence.js";
import { ocrLanguage } from "../src/server/services/ocr.js";

const word=(str,x,y,{block="body",line="1",offset=0,height=15}={})=>({str,xmin:x,ymin:y,xmax:x+str.length*8,ymax:y+height,source:"ocr_text",blockId:block,paragraphId:"1",lineId:line,textStart:offset,textEnd:offset+str.length});
const locationWords=items=>items.map(w=>({...w,text:w.str,x:w.xmin,y:w.ymin,width:w.xmax-w.xmin,height:w.ymax-w.ymin}));

test("sidebar numbers survive SAGE ranking and differ from numeric internal IDs",()=>{
  const pages=[{pageNumber:3,issues:[{uid:"heading",quote:"words Patterns"}]},{pageNumber:4,issues:[{uid:"old-caption",quote:"will Complete"}]},
    {pageNumber:6,issues:[{uid:"stem",quote:"Find the missing number, if same rule is following in all the four figures."},{uid:"punctuation",quote:"Find the missing number in the given number pattern"}]}];
  const sidebarIssueMap=[{number:2,uid:"heading",page:3},{number:7,uid:"old-caption",page:4},{number:12,uid:"stem",page:6},{number:13,uid:"punctuation",page:6}];
  const result=compactIssues(pages,"where are issue numbers 12, 13",6,{sidebarIssueMap});
  assert.deepEqual(result.slice(0,2).map(i=>[i.sidebarNumber,i.page,i.uid]),[[12,6,"stem"],[13,6,"punctuation"]]);
  assert.equal(result.find(i=>i.uid==="heading").sidebarNumber,2);
  assert.deepEqual(referencedIssueNumbers("issue number 12 , 13, 14"),[12,13,14]);
});

test("persisted Mongoose findings retain their UID and text in SAGE context",()=>{
  const page=new Page({bookId:"0123456789abcdef01234567",pageNumber:6,issues:[{uid:"stem",type:"grammar",quote:"if same rule",suggestion:"if the same rule"}]});
  const result=compactIssues([{pageNumber:6,issues:page.issues}],"issue 12",6,{sidebarIssueMap:[{number:12,uid:"stem",page:6}]});
  assert.equal(result[0].quote,"if same rule");assert.equal(result[0].uid,"stem");
});

test("stale, forged and duplicate sidebar labels are rejected",()=>{
  const pages=[{pageNumber:6,issues:[{uid:"a"},{uid:"b"}]}];
  for(const sidebarIssueMap of [[{number:12,uid:"unknown",page:6}],[{number:12,uid:"a",page:3}],
    [{number:12,uid:"a",page:6},{number:12,uid:"b",page:6}],[{number:12,uid:"a",page:6},{number:13,uid:"a",page:6}]])
    assert.throws(()=>compactIssues(pages,"issue 12",6,{sidebarIssueMap}),/refresh/);
});

test("page context includes later headings and handles long text without a full stop",()=>{
  const text="Introductory source facts. ".repeat(180)+"words Patterns is the printed heading near the lower page.";
  const context=retrievePageContext({text,query:"heading words Patterns"});
  assert.match(context,/words Patterns/);assert.ok(context.length>2800);assert.ok(context.length<=12000);
  const long=retrievePageContext({text:"pattern ".repeat(3000),query:"pattern"});assert.ok(long.length>2000 && long.length<=12000);
});

test("a truncated SAGE answer is never interpreted as zero observations",()=>{
  assert.throws(()=>parseCompanionResponse({text:'{"answer":"Partial", "observations":[]}',candidates:[{finishReason:"MAX_TOKENS"}]}),/incomplete/);
  assert.throws(()=>parseCompanionResponse({text:'{"answer":"Fine"}'}),/incomplete/);
  assert.equal(parseCompanionResponse({text:'{"answer":"Verified", "observations":[]}',candidates:[{finishReason:"STOP"}]}).answer,"Verified");
});

test("an isolated lowercase coloured heading is flagged and remains across omissions",()=>{
  const items=[word("words",100,700,{block:"heading",offset:100}),word("Patterns",146,700,{block:"heading",offset:106}),
    word("find",100,750,{line:"2"}),word("the",138,750,{line:"2"}),word("pattern",169,750,{line:"2"})];
  const findings=lintHeadingLayout(items);
  assert.equal(findings.length,1);assert.equal(findings[0].quote,"words Patterns");assert.equal(findings[0].suggestion,"Words Patterns");assert.equal(findings[0].boxSource,"ocr_text");
  const reviewed={...findings[0],status:"accepted"};
  const omitted=reconcileAnalysisIssues([reviewed],[]);assert.equal(omitted[0].uid,reviewed.uid);assert.equal(omitted[0].status,"accepted");
  const rediscovered=reconcileAnalysisIssues(omitted,lintHeadingLayout(items));assert.equal(rediscovered.length,1);assert.equal(rediscovered[0].uid,reviewed.uid);
  assert.equal(lintHeadingLayout(items.map(w=>w.str==="words"?{...w,str:"Words"}:w)).length,0);
});

test("ordinary lowercase body text and body references to names are not headings",()=>{
  assert.equal(lintHeadingLayout([word("the",100,100),word("Patterns",138,100)]).length,0);
  assert.equal(lintHeadingLayout([word("find",100,100),word("the",139,100),word("pattern",170,100)]).length,0);
});

test("mixed-column OCR phrases wrap within their own column",()=>{
  const items=[word("Find",100,100,{offset:0}),word("the",142,100,{offset:5}),word("missing",177,100,{offset:9}),
    word("Other",600,100,{offset:17}),word("column",651,100,{offset:23}),
    word("number,",100,120,{line:"2",offset:30}),word("if",164,120,{line:"2",offset:38}),word("same",185,120,{line:"2",offset:41}),word("rule",228,120,{line:"2",offset:46}),
    word("More",600,120,{line:"2",offset:51}),word("text",645,120,{line:"2",offset:56}),
    word("is",100,140,{line:"3",offset:61}),word("following",125,140,{line:"3",offset:64})];
  const matches=findTextMatches(locationWords(items),"Find the missing number, if same rule is following",{caseSensitive:true,literalOnly:true});
  assert.equal(matches.length,1);assert.ok(matches[0].box.xmax<500);assert.equal(matches[0].source,"ocr_text");
  assert.equal(findTextMatches(locationWords([word("Find",100,100),word("missing",600,100)]),"Find missing").length,0);
});

test("OCR line and paragraph metadata preserve readable line breaks",()=>{
  const text=layoutTranscript([word("Words",100,100,{block:"heading"}),word("Patterns",150,100,{block:"heading"}),word("A",100,160),word("sentence",120,160)]);
  assert.equal(text,"Words Patterns\nA sentence");
});

test("page analysis makes exactly one request and ignores obsolete crop/revisit options",async()=>{
  const events=[]; const finding={uid:"upper",quote:"will Complete",suggestion:"will complete"};
  const result=await analyzePageOnce({priorFindings:[finding],regionImages:[{id:"top_left"}],coveragePass:true},
    {analyze:async options=>{events.push("request");assert.equal(options.regionImages,undefined);assert.equal(options.coveragePass,undefined);return {issues:[finding],tokensUsed:10};},
      onPartialIssues:async issues=>{events.push("saved");assert.equal(issues[0].uid,"upper");}});
  assert.deepEqual(events,["request","saved"]);assert.equal(result.tokensUsed,10);
  assert.deepEqual(result.coverage,{complete:true,passes:1});
});

test("provider failures do not trigger an automatic page retry",async()=>{
  let calls=0;await assert.rejects(analyzePageOnce({},{analyze:async()=>{calls++;throw new Error("503 UNAVAILABLE");}}),/503/);
  assert.equal(calls,1);
});

test("a failed persistence callback never causes another model call",async()=>{
  let calls=0;await assert.rejects(analyzePageOnce({},{analyze:async()=>{calls++;return {issues:[]};},onPartialIssues:async()=>{throw new Error("claim revoked");}}),/claim revoked/);
  assert.equal(calls,1);
});

test("scanned index evidence distinguishes printed labels from observed PDF positions",()=>{
  const pages=[{pageNumber:2,structuredText:"Contents\n1 Patterns 1\n2 Reasoning 10",evidenceIndexed:true},
    {pageNumber:3,structuredText:"Chapter 1: Patterns\nSource content",evidenceIndexed:true,textLayout:[word("Chapter",100,100)]}];
  const structure=structureFromEvidence({chapters:[],toc:[]},pages,99);
  assert.equal(structure.status,"partial");assert.equal(structure.chapters.find(c=>c.name==="Patterns").page,3);
  assert.equal(structure.toc.find(t=>t.source==="printed_toc"&&t.title==="Patterns").page,null);
  assert.equal(structure.toc.find(t=>t.source==="printed_toc"&&t.title==="Patterns").printedPage,1);
  assert.match(localChapterContext(structure.chapters[1],pages,3),/1\/97 chapter pages/);assert.match(localChapterContext(structure.chapters[1],pages,3),/PARTIAL CONTEXT/);
});

test("changed source text invalidates ready chapter memory without changing chapter boundaries", async t => {
  const pages = [1, 2].map(pageNumber => ({ pageNumber, structuredText: `Source facts on page ${pageNumber}.`, evidenceIndexed: true }));
  const book = { _id: "book", pageCount: 2, structure: { chapters: [
    { number: 1, name: "Patterns", page: 1, pageNumbering: "pdf", source: "body_heading", confidence: .95 },
  ] } };
  let record;
  let writes = 0;
  t.mock.method(Page, "find", () => ({ select: () => ({ sort: () => ({ lean: async () => structuredClone(pages) }) }) }));
  t.mock.method(Book, "updateOne", async () => ({}));
  t.mock.method(ChapterContext, "deleteMany", async () => ({}));
  t.mock.method(ChapterContext, "findOne", async () => record);
  t.mock.method(ChapterContext, "findOneAndUpdate", async (_filter, update) => {
    writes++;
    record = { ...update.$set, save: async () => record };
    return record;
  });
  await refreshEvidenceIndex(book);
  const firstHash = record.contentHash;
  const boundaries = structuredClone(book.structure.chapters);
  record.status = "ready";
  record.memory = { overview: "Earlier source facts" };
  await refreshEvidenceIndex(book);
  assert.equal(writes, 1);
  assert.equal(record.status, "ready");
  pages[1].structuredText = "Corrected source facts on page 2.";
  await refreshEvidenceIndex(book);
  assert.deepEqual(book.structure.chapters, boundaries);
  assert.equal(writes, 2);
  assert.notEqual(record.contentHash, firstHash);
  assert.equal(record.status, "pending");
  assert.deepEqual(record.memory, {});
});



test("invalid OCR language paths cannot become command arguments",()=>{
  const previous=process.env.OCR_LANGUAGE;try{process.env.OCR_LANGUAGE="../../bad";assert.throws(()=>ocrLanguage("english"),/Invalid OCR language/);}finally{if(previous===undefined)delete process.env.OCR_LANGUAGE;else process.env.OCR_LANGUAGE=previous;}
});

test("OCR language-load faults fail in a child and the web process survives",{timeout:15000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"proofdesk-ocr-fault-"));
  try{
    const image=path.join(directory,"blank.png");const canvas=createCanvas(200,200);canvas.getContext("2d").fillRect(0,0,200,200);await fs.writeFile(image,await canvas.encode("png"));
    const moduleUrl=new URL("../src/server/services/ocr.js",import.meta.url).href;
    const script=`import {recogniseImage} from ${JSON.stringify(moduleUrl)};try{await recogniseImage(process.argv[1],"eng",{timeout:2000});process.exitCode=2;}catch{process.stdout.write("WEB_PROCESS_SURVIVED");}`;
    const result=await promisify(execFile)(process.execPath,["--input-type=module","-e",script,image],{timeout:12000,env:{...process.env,TESSERACT_CMD:path.join(directory,"missing-tesseract"),OCR_LANG_PATH:path.join(directory,"missing-language")}});
    assert.equal(result.stdout,"WEB_PROCESS_SURVIVED");
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});


test("white text on a green banner survives OCR and receives a measured heading finding",{timeout:60000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"proofdesk-banner-test-"));
  try{
    const canvas=createCanvas(1600,2000),context=canvas.getContext("2d");context.fillStyle="white";context.fillRect(0,0,1600,2000);
    context.fillStyle="#00ae55";context.fillRect(780,1300,720,90);context.fillStyle="white";context.font="bold 48px sans-serif";context.fillText("words Patterns",890,1362);
    context.fillStyle="black";context.font="32px sans-serif";context.fillText("Find the pattern in these examples.",100,1450);
    const pdf=await PDFDocument.create(),page=pdf.addPage([600,750]);const image=await pdf.embedPng(await canvas.encode("png"));page.drawImage(image,{x:0,y:0,width:600,height:750});
    const file=path.join(directory,"banner.pdf");await fs.writeFile(file,await pdf.save());
    await withPdf(file,async doc=>{
      const evidence=await extractPageEvidence(doc,1,{language:"english"});const headings=lintHeadingLayout(evidence.layoutItems);
      const found=headings.find(i=>i.quote==="words Patterns");assert.ok(found);assert.equal(found.boxSource,"ocr_text");assert.ok(found.box.xmin>500 && found.box.ymin>600);
      assert.ok(!headings.some(i=>i.quote.includes("these examples")));
    });
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test("a tall OCR descender in a wrapped exercise is insufficient evidence of a heading",()=>{
  const body=[word("Find",100,100,{line:"1"}),word("the",140,100,{line:"1"}),word("given",100,125,{line:"2",block:"wrap",height:28}),word("number",147,125,{line:"2",block:"wrap"}),word("pattern",204,125,{line:"2",block:"wrap"})];
  assert.equal(lintHeadingLayout(body).length,0);
  const noise=[{...word("wy",100,300,{block:"noise"}),confidence:.46},{...word("Fa",128,300,{block:"noise"}),confidence:.42}];assert.equal(lintHeadingLayout(noise).length,0);
});
