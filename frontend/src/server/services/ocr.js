import os from "os";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
const runFile = promisify(execFile);
const childScript = path.join(process.cwd(), "src/server/services/ocr-child.cjs");

export function ocrLanguage(language) {
  const languages = { english: "eng", hindi: "hin", mixed: "eng+hin", french: "fra", german: "deu", spanish: "spa", arabic: "ara", tamil: "tam", telugu: "tel", bengali: "ben" };
  const value = process.env.OCR_LANGUAGE || languages[String(language || "english").toLowerCase()] || "eng";
  if (!/^[a-zA-Z_]+(?:\+[a-zA-Z_]+)*$/.test(value)) throw new Error("Invalid OCR language configuration");
  return value;
}

export async function recogniseImage(imagePath, language, { timeout = 30000, psm = 3 } = {}) {
  try {
    const { stdout } = await runFile(process.env.TESSERACT_CMD || "tesseract",
      [imagePath, "stdout", "-l", language, "--psm", String(psm), "--dpi", "300", "tsv"],
      { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, killSignal: "SIGKILL" });
    return stdout;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), "proofdesk-language-"));
    try {
      const { stdout } = await runFile(process.execPath,
        [childScript, imagePath, language, cache, String(psm)],
        { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, killSignal: "SIGKILL" });
      return stdout;
    } finally { await fs.rm(cache, { recursive: true, force: true }).catch(() => {}); }
  }
}
