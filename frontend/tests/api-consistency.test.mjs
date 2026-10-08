import { lintUnitLabels } from "../src/server/services/unit-label-checks.js";
import { hasSubstantialNativeEvidence } from "../src/server/services/pdf.js";
import { lintAlphabetSteps } from "../src/server/services/alphabet-checks.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import { snapIssuesToLayout } from "../src/server/services/pdf.js";
import { lintHeadingLayout } from "../src/server/services/heading-checks.js";
import * as reconciliation from "../src/server/services/issue-reconciliation.js";
import * as sageContext from "../feature/agentic-bot/server/context.js";
import * as validation from "../src/server/validation.js";

const require = createRequire(import.meta.url);
const bookId = "0123456789abcdef01234567";
const http = {
  ...validation,
  assertSameOrigin() {},
  apiError(error, fallback) {
    const status = error.status || 500;
    return Response.json({ error: status >= 500 ? fallback : error.message }, { status });
  },
};

// Execute the real route handler with an isolated persistence/provider boundary.
// No MongoDB, network credentials, or live documents are needed by this suite.
async function loadRoute(relativePath, dependencies, runtime = {}) {
  const source = await fs.readFile(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module, exports: module.exports,
    require(name) {
      if (name === "next/server") return { NextResponse: { json: Response.json } };
      if (name === "@/server/http.js") return http;
      if (name in dependencies) return dependencies[name];
      return require(name);
    },
    console, setTimeout, clearTimeout, process, Response, ReadableStream, AbortController, URL, ...runtime,
  }, { filename: relativePath });
  return module.exports;
}

function issueRequest(status) {
  return new Request("http://localhost/api/issues", { method: "PATCH", body: JSON.stringify({ status }) });
}

test("parallel review decisions update separate findings without losing either decision", async () => {
  const page = { bookId, pageNumber: 4, issueRevision: 0, issues: [
    { uid: "upper", status: "open" }, { uid: "lower", status: "open" },
  ] };
  const Page = {
    async findOneAndUpdate(query, update) {
      await new Promise((resolve) => setTimeout(resolve, query["issues.uid"] === "upper" ? 10 : 1));
      const issue = page.issues.find((item) => item.uid === query["issues.uid"]);
      if (!issue || query.bookId !== bookId || query.pageNumber !== 4) return null;
      issue.status = update.$set["issues.$.status"];
      page.issueRevision += update.$inc?.issueRevision || 0;
      return structuredClone(page);
    },
  };
  const { PATCH } = await loadRoute("../src/app/api/books/[id]/pages/[pageNumber]/issues/[uid]/route.ts", {
    "@/server/models/Page.js": { default: Page },
    "@/server/db.js": { connectDb: async () => {} },
    "@/server/services/queue.js": { serializePage: (value) => value, refreshBookStats: async () => {} },
  });
  const results = await Promise.all([
    PATCH(issueRequest("accepted"), { params: { id: bookId, pageNumber: "4", uid: "upper" } }),
    PATCH(issueRequest("dismissed"), { params: { id: bookId, pageNumber: "4", uid: "lower" } }),
  ]);
  assert.deepEqual(results.map((response) => response.status), [200, 200]);
  assert.equal(page.issues[0].status, "accepted");
  assert.equal(page.issues[1].status, "dismissed");
  assert.equal(page.issueRevision, 2);
});

test("malformed issue mutation requests fail before contacting storage", async () => {
  let dbCalls = 0;
  const { PATCH } = await loadRoute("../src/app/api/books/[id]/pages/[pageNumber]/issues/[uid]/route.ts", {
    "@/server/models/Page.js": { default: {} },
    "@/server/db.js": { connectDb: async () => { dbCalls += 1; } },
    "@/server/services/queue.js": {},
  });
  const requests = [
    [issueRequest("accepted"), { id: "bad", pageNumber: "4", uid: "upper" }],
    [issueRequest("accepted"), { id: bookId, pageNumber: "NaN", uid: "upper" }],
    [issueRequest("unknown"), { id: bookId, pageNumber: "4", uid: "upper" }],
    [new Request("http://localhost/api/issues", { method: "PATCH", body: "null" }), { id: bookId, pageNumber: "4", uid: "upper" }],
  ];
  for (const [request, params] of requests) assert.equal((await PATCH(request, { params })).status, 400);
  assert.equal(dbCalls, 0);
});

test("a failed partial enqueue removes orphan page jobs and all multipart source assets", async () => {
  const events = [];
  const book = { _id: bookId, save: async () => {}, pageCount: 0 };
  const { POST } = await loadRoute("../src/app/api/analyze/route.ts", {
    "@/server/models/Book.js": { default: {
      create: async (values) => { Object.assign(book, values); return book; },
      updateOne: async () => events.push("stop claims"),
      deleteOne: async () => events.push("delete book"),
    } },
    "@/server/models/Page.js": { default: { deleteMany: async () => events.push("delete orphan pages") } },
    "@/server/db.js": { connectDb: async () => {} },
    "@/server/storage.js": {
      tempPdfPath: () => "/tmp/mock.pdf", downloadPdfObject: async () => {},
      validateUploadKey: (value) => value, validatePdfParts: (value) => value,
      deleteUploadObject: async () => events.push("delete unused upload"),
    },
    "@/server/services/pdf.js": { getPageCount: async () => 2 },
    "@/server/services/queue.js": {
      enqueueBook: async () => { throw new Error("partial insert failed"); },
      removeBookFiles: async () => events.push(`delete ${book.pdfParts} source parts`),
      serializeBook: (value) => value,
    },
    "@/server/services/gemini.js": { DEFAULT_MODEL: "test", hasAnyKey: () => true, resolveModel: () => "test" },
    "../../../../feature/agentic-bot/server/instructions.js": { compileProjectInstructions: () => ({ text: "" }) },
  });
  const response = await POST(new Request("http://localhost/api/analyze", {
    method: "POST", body: JSON.stringify({ objectKey: "proofreader_assets/pdf_test", totalParts: 2 }),
  }));
  assert.equal(response.status, 500);
  assert.deepEqual(events, ["stop claims", "delete orphan pages", "delete 2 source parts", "delete book"]);
});

function pdfRouteDependencies(parts = 1) {
  return {
    "@/server/models/Book.js": { default: {
      findById: () => ({ lean: async () => ({
        cloudinaryPdfKey: "proofreader_assets/pdf_test", pdfParts: parts, originalName: "reasoning हिन्दी.pdf",
      }) }),
    } },
    "@/server/db.js": { connectDb: async () => {} },
    "@/server/validation.js": validation,
    "@/server/storage.js": {
      MAX_PDF_BYTES: 250 * 1024 * 1024, validatePdfParts: Number,
      pdfObjectUrl: (_key, part) => `https://storage.example/part${part}`,
    },
  };
}

test("PDF responses concatenate streamed parts and keep Unicode filenames valid", async () => {
  const calls = [];
  const { GET } = await loadRoute("../src/app/api/books/[id]/file/route.ts", pdfRouteDependencies(2), {
    fetch: async (url) => { calls.push(url); return new Response(calls.length === 1 ? "%PDF-first" : "second"); },
  });
  const response = await GET(new Request("http://localhost/api/pdf"), { params: { id: bookId } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "%PDF-firstsecond");
  assert.deepEqual(calls, ["https://storage.example/part0", "https://storage.example/part1"]);
  assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8/);
});

test("PDF cancellation stops the remote download instead of buffering the entire part", async () => {
  let sourcePulls = 0;
  let sourceCancelled = false;
  let remoteSignal;
  const { GET } = await loadRoute("../src/app/api/books/[id]/file/route.ts", pdfRouteDependencies(), {
    fetch: async (_url, options) => {
      remoteSignal = options.signal;
      return new Response(new ReadableStream({
        pull(controller) {
          sourcePulls += 1;
          controller.enqueue(new TextEncoder().encode(sourcePulls === 1 ? "%PDF-first" : "chunk"));
          if (sourcePulls === 100) controller.close();
        },
        cancel() { sourceCancelled = true; },
      }));
    },
  });
  const response = await GET(new Request("http://localhost/api/pdf"), { params: { id: bookId } });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.ok(sourcePulls < 100);
  assert.equal(sourceCancelled, true);
  assert.equal(remoteSignal.aborted, true);
});

test("missing first PDF part returns an API failure before committing HTTP 200", async () => {
  const { GET } = await loadRoute("../src/app/api/books/[id]/file/route.ts", pdfRouteDependencies(), {
    fetch: async () => new Response("Missing", { status: 404 }),
  });
  const response = await GET(new Request("http://localhost/api/pdf"), { params: { id: bookId } });
  assert.equal(response.status, 502);
});


test("worker response awaits durable page processing instead of scheduling work after HTTP completion",async()=>{
  let resolveWork,finished=false;const pending=new Promise(resolve=>{resolveWork=resolve;});
  const {POST}=await loadRoute("../src/app/api/worker/route.ts",{
    "@/server/db.js":{connectDb:async()=>{}},
    "@/server/services/queue.js":{runWorkerSlice:async({bookId:id})=>{assert.equal(id,bookId);await pending;finished=true;return {processed:1};}},
  });
  let responded=false;const response=POST(new Request("http://localhost/api/worker",{method:"POST",headers:{origin:"http://localhost"},body:JSON.stringify({bookId})})).then(value=>{responded=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,15));assert.equal(responded,false);assert.equal(finished,false);
  resolveWork();assert.equal((await response).status,200);assert.equal(finished,true);
});

test("unauthorised worker requests fail before contacting MongoDB or a provider",async()=>{
  let calls=0;const {POST,GET}=await loadRoute("../src/app/api/worker/route.ts",{
    "@/server/db.js":{connectDb:async()=>{calls++;}},"@/server/services/queue.js":{},
  });
  assert.equal((await POST(new Request("http://localhost/api/worker",{method:"POST",body:JSON.stringify({bookId})}))).status,403);
  assert.equal((await GET(new Request("http://localhost/api/worker"))).status,405);assert.equal(calls,0);
});


async function companionFixture({issues=[],layout=[],reply={answer:"Checked the current source.",observations:[]},missingPdf=false}={}) {
  let providerCalls=0,pdfRecoveries=0;const page={_id:"page",bookId,pageNumber:6,textLayout:layout,textExtract:layout.map(w=>w.str).join(" "),issues,issueRevision:0};
  const book={_id:bookId,title:"Reasoning",pageCount:99,status:"paused",filePath:"/tmp/mock.pdf",language:"english",model:"test"};
  const session={_id:"session",knowledge:[],messages:[]};
  const query=()=>({select(){return this;},sort(){return this;},lean:async()=>structuredClone(page)});
  const Page={findOne:query,find:()=>({select(){return this;},sort(){return this;},lean:async()=>[structuredClone(page)]}),findOneAndUpdate:async(filter,update)=>{
    if(filter.issueRevision!==page.issueRevision)return null;Object.assign(page,structuredClone(update.$set));page.issueRevision+=update.$inc?.issueRevision||0;return structuredClone(page);
  }};
  const {postAgentMessage}=await loadRoute("../feature/agentic-bot/server/handler.ts",{
    "@/server/models/Book.js":{default:{findById:async()=>book}},"@/server/models/Page.js":{default:Page},"@/server/db.js":{connectDb:async()=>{}},
    "@/server/services/gemini.js":{resolveModel:()=>"test",getClient:()=>({models:{generateContent:async()=>{providerCalls++;return {text:JSON.stringify(reply),candidates:[{finishReason:"STOP"}]};}}})},
    "@/server/services/queue.js":{},"../../../src/server/services/queue.js":{ensureLocalPdf:async()=>{pdfRecoveries++;if(missingPdf)throw new Error("storage unavailable");return "/tmp/mock.pdf";}},
    "../../../src/server/services/pdf.js":{hasSubstantialNativeEvidence,snapIssuesToLayout,withPdf:async()=>{throw new Error("test PDF unavailable");},extractPageEvidence:()=>{}},
    "../../../src/server/services/alphabet-checks.js":{lintAlphabetSteps},
    "../../../src/server/services/unit-label-checks.js":{lintUnitLabels},
    "../../../src/server/services/heading-checks.js":{lintHeadingLayout},"../../../src/server/services/issue-reconciliation.js":reconciliation,
    "../../../src/server/services/structure.js":{getPageContextFromStructure:()=>({})},"../../chapter-proofreader/server/service.js":{getChapterContextForAnalysis:async()=>({context:"Partial chapter evidence"})},
    "./context.js":sageContext,"./AgentSession.js":{default:{findOneAndUpdate:async()=>session,updateOne:async(_filter,update)=>{session.messages.push(...update.$push.messages.$each);}}},
  });
  const send=(message,sidebarIssueMap)=>postAgentMessage(new Request("http://localhost/api/agentic-bot",{method:"POST",headers:{origin:"http://localhost"},body:JSON.stringify({bookId,pageNumber:6,message,sidebarIssueMap})}));
  return {send,page,providerCalls:()=>providerCalls,pdfRecoveries:()=>pdfRecoveries};
}
const sageWord=(str,x,offset)=>({str,xmin:x,ymin:500,xmax:x+str.length*8,ymax:515,textStart:offset,textEnd:offset+str.length,source:"pdf_text",blockId:"body",lineId:"1"});

test("SAGE answers a displayed issue number from that exact UID, not ranked array position",async()=>{
  const fixture=await companionFixture({issues:[{uid:"stem",type:"grammar",quote:"Find the missing number",suggestion:"Find the missing number.",boxSource:"unverified"}],
    layout:[sageWord("Find",100,0),sageWord("the",140,5),sageWord("missing",172,9),sageWord("number",232,17)]});
  const response=await fixture.send("where is issue number 12",[{number:12,uid:"stem",page:6}]);const result=await response.json();
  assert.equal(response.status,200);assert.match(result.answer,/Issue 12: Page 6, left side/);assert.match(result.answer,/Find the missing number/);assert.equal(fixture.providerCalls(),0);
});

test("SAGE persists a verified new observation and keeps it when a later reply omits it",async()=>{
  const reply={answer:"Complete should start with a lowercase c in this sentence.",observations:[{type:"typography",severity:"minor",quote:"will Complete",suggestion:"will complete",explanation:"Mid-sentence capitalisation."}]};
  const fixture=await companionFixture({reply,issues:[{uid:"earlier",type:"punctuation",quote:"Heading :",suggestion:"Heading:",status:"accepted"}],layout:[sageWord("will",100,0),sageWord("Complete",140,5),sageWord("figure.",220,14)]});
  const first=await fixture.send("check this sentence",[{number:1,uid:"earlier",page:6}]);assert.equal(first.status,200);assert.equal(fixture.page.issues.length,2);
  const found=fixture.page.issues.find(i=>i.quote==="will Complete");assert.equal(found.source,"sage");assert.equal(found.boxSource,"pdf_text");assert.match((await first.json()).answer,/were saved/);
  reply.observations=[];const second=await fixture.send("anything else",fixture.page.issues.map((i,index)=>({number:index+1,uid:i.uid,page:6})));
  assert.equal(second.status,200);assert.equal(fixture.page.issues.length,2);assert.equal(fixture.page.issues.find(i=>i.uid==="earlier").status,"accepted");assert.equal(fixture.page.issues.find(i=>i.quote==="will Complete").uid,found.uid);
});

test("SAGE can answer from saved evidence during a source-storage outage",async()=>{
  const fixture=await companionFixture({missingPdf:true});const response=await fixture.send("explain what is recorded",[]);
  assert.equal(response.status,200);assert.equal(fixture.providerCalls(),1);
});


test("ordinary SAGE conversation never restores the full source PDF",async()=>{
  const fixture=await companionFixture({missingPdf:true});
  for(const message of ["hello","how many findings are saved","explain the saved results"]) {
    const response=await fixture.send(message,[]);assert.equal(response.status,200);
  }
  assert.equal(fixture.pdfRecoveries(),0);
});
