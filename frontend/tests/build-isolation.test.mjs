import test from "node:test";
import assert from "node:assert/strict";
import config from "../next.config.mjs";
import constants from "next/constants.js";

test("development and production webpack outputs cannot overwrite each other",t=>{
  const previous=process.env.PROOFDESK_BUILD_DIR;
  delete process.env.PROOFDESK_BUILD_DIR;
  t.after(()=>{if(previous===undefined)delete process.env.PROOFDESK_BUILD_DIR;else process.env.PROOFDESK_BUILD_DIR=previous;});
  assert.equal(config(constants.PHASE_DEVELOPMENT_SERVER).distDir,".next-dev");
  assert.equal(config(constants.PHASE_PRODUCTION_BUILD).distDir,".next");
  assert.equal(config(constants.PHASE_PRODUCTION_SERVER).distDir,".next");
  process.env.PROOFDESK_BUILD_DIR=".next-isolated-check";
  assert.equal(config(constants.PHASE_PRODUCTION_BUILD).distDir,".next-isolated-check");
});
