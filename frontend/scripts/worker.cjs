// Optional persistent worker. Uses the same Mongo claims as browser requests.
const {loadEnvConfig}=require("@next/env");loadEnvConfig(process.cwd(),false);
(async()=>{
  const {connectDb}=await import("../src/server/db.js");
  const {runWorkerSlice}=await import("../src/server/services/queue.js");
  let stopped=false;process.on("SIGTERM",()=>{stopped=true;});process.on("SIGINT",()=>{stopped=true;});
  await connectDb();
  while(!stopped) {
    try{await runWorkerSlice();}catch{process.stderr.write("Worker request failed; saved claims can recover.\n");}
    if(!stopped)await new Promise(resolve=>setTimeout(resolve,3000));
  }
  await require("mongoose").disconnect();
})().catch(()=>{process.stderr.write("Worker configuration is unavailable.\n");process.exitCode=1;});
