import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import ts from 'typescript';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import '../src/server/services/pdf.js';
const source = await fs.readFile(new URL('../src/lib/pdf-text-locator.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const code = outputText.replace('"./text-geometry.js"', JSON.stringify(new URL('../src/lib/text-geometry.js', import.meta.url).href))
  .replace('import("pdfjs-dist")', `import(${JSON.stringify(new URL('../node_modules/pdfjs-dist/build/pdf.js', import.meta.url).href)})`);
const { findInWords, locateIssuesInPdf } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const hint = { x: 10, y: 10, w: 20, h: 2 };

test('client refuses case-only and punctuation-only grounding on already corrected text', () => {
  assert.equal(findInWords([{ text: 'will complete the figure.', x: 100, y: 100, width: 200, height: 20 }], 1000, 1000,
    'will Complete the figure.', hint, 'will complete the figure.'), null);
  assert.equal(findInWords([{ text: 'cat and dog', x: 100, y: 100, width: 200, height: 20 }], 1000, 1000,
    'cat: and dog', hint, 'cat and dog'), null);
  assert.deepEqual(findInWords([{ text: 'will Complete the figure.', x: 100, y: 100, width: 200, height: 20 }], 1000, 1000,
    'will Complete the figure.', hint, 'will complete the figure.'), hint);
});

test('current PDF evidence removes a previously trusted erroneous capitalization box', async () => {
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  src.addPage([600, 800]).drawText('will complete the figure.', { x: 100, y: 600, font, size: 12 });
  const file = new File([await src.save()], 'corrected.pdf', { type: 'application/pdf' });
  const result = await locateIssuesInPdf(file, [{ originalText: 'will Complete the figure.', suggestedText: 'will complete the figure.',
    type: 'typography', page: 1, bboxSource: 'pdf_text', bbox: hint }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].bboxSource, 'unverified');
  assert.equal(result[0].bbox, undefined);
});
