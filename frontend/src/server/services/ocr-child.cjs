// Keep worker-thread faults and language-download failures outside the web process.
const { createWorker } = require("tesseract.js");
(async () => {
  let worker;
  try {
    worker = await createWorker({ cachePath: process.argv[4],
      ...(process.env.OCR_LANG_PATH ? { langPath: process.env.OCR_LANG_PATH } : {}),
      errorHandler() {}, logger() {} });
    await worker.loadLanguage(process.argv[3]);
    await worker.initialize(process.argv[3]);
    await worker.setParameters({ tessedit_pageseg_mode: process.argv[5] || "3" });
    const { data } = await worker.recognize(process.argv[2]);
    process.stdout.write(data.tsv || "");
  } catch {
    process.stderr.write("OCR worker could not load language data or recognise this image.\n");
    process.exitCode = 1;
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }
})().catch(() => { process.exitCode = 1; });
