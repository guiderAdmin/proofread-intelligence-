import * as nodeModule from "module";
import * as nodeFs from "fs";
import * as nodeUrl from "url";
import { DOMMatrix, Image, ImageData, Path2D } from "@napi-rs/canvas";

if (typeof process.getBuiltinModule !== "function") {
  process.getBuiltinModule = (name) => {
    if (name === "module") return nodeModule;
    if (name === "fs") return nodeFs;
    if (name === "url") return nodeUrl;
    throw new Error(`Unsupported built-in module requested by PDF.js: ${name}`);
  };
}

if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrix;
if (!globalThis.Image) globalThis.Image = Image;
if (!globalThis.ImageData) globalThis.ImageData = ImageData;
if (!globalThis.Path2D) globalThis.Path2D = Path2D;
