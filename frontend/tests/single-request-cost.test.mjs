import test from "node:test";
import assert from "node:assert/strict";
import { getClient, analyzePageOnce } from "../src/server/services/gemini.js";
import { reconcileAnalysisIssues } from "../src/server/services/issue-reconciliation.js";

function configure(t) {
  const previous={key:process.env.GEMINI_API_KEY,gap:process.env.GEMINI_MIN_GAP_MS,models:process.env.GEMINI_MODELS_PER_ATTEMPT};
  process.env.GEMINI_API_KEY="test-not-a-real-key";process.env.GEMINI_MIN_GAP_MS="0";process.env.GEMINI_MODELS_PER_ATTEMPT="2";
  t.after(()=>{for(const [name,value] of [["GEMINI_API_KEY",previous.key],["GEMINI_MIN_GAP_MS",previous.gap],["GEMINI_MODELS_PER_ATTEMPT",previous.models]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}});
}

test("real page request has only one attachment and one API call",async t=>{
  configure(t);let calls=0,payload;
  t.mock.method(globalThis,"fetch",async (_url,options)=>{calls++;payload=JSON.parse(options.body);return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({pageKind:"content",issues:[]})}]},finishReason:"STOP"}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,totalTokenCount:120}});});
  const result=await analyzePageOnce({imageBytes:Buffer.from("fake-jpeg"),pageNumber:4,pageCount:99,language:"english",model:"gemini-3.6-flash",priorFindings:[]});
  assert.equal(calls,1);assert.equal(result.tokensUsed,120);assert.equal(result.coverage.passes,1);
  assert.equal(payload.contents[0].parts.filter(part=>part.inlineData).length,1);
  assert.equal(payload.contents[0].parts.some(part=>/crop|INDEPENDENT COVERAGE REVIEW/.test(part.text||"")),false);
});

test("Gemini SDK does not retry a failed SAGE/chapter-style call",async t=>{
  configure(t);let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({error:{code:503,message:"UNAVAILABLE",status:"UNAVAILABLE"}},{status:503});});
  await assert.rejects(getClient().models.generateContent({model:"gemini-3.6-flash",contents:"test"}));
  assert.equal(calls,1);
});

test("old fallback environment settings cannot add page model calls",async t=>{
  configure(t);let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({error:{code:503,message:"UNAVAILABLE",status:"UNAVAILABLE"}},{status:503});});
  await assert.rejects(analyzePageOnce({imageBytes:Buffer.from("fake-jpeg"),pageNumber:1,pageCount:1,model:"gemini-3.6-flash"}));
  assert.equal(calls,1);
});

test("one-pass reanalysis still keeps omitted earlier findings and decisions",()=>{
  const earlier={uid:"alphabet-arrow",quote:"+1",suggestion:"-1",type:"number",status:"accepted",textStart:302,boxSource:"ocr_text"};
  const findings=reconcileAnalysisIssues([earlier],[]);
  assert.equal(findings.length,1);assert.equal(findings[0].uid,earlier.uid);assert.equal(findings[0].status,"accepted");
});
