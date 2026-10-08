import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { openPdf, extractPageLayout, extractPageText, extractPageEvidence, snapIssuesToLayout, parseTesseractTsv, withPdf } from '../src/server/services/pdf.js';
import { clampBox, findTextMatches, tokenizeForLocation } from '../src/lib/text-geometry.js';

const quote = 'will Complete the figure.';
const correction = () => ({ uid: 'original', type: 'typography', quote, suggestion: 'will complete the figure.', status: 'open', box: { xmin: 100, ymin: 230, xmax: 510, ymax: 255 }, boxSource: 'ai' });
async function fixturePdf(build, fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proofdesk-geometry-test-'));
  let doc;
  try {
    const src = await PDFDocument.create();
    await build(src);
    const filePath = path.join(directory, 'fixture.pdf');
    await fs.writeFile(filePath, await src.save());
    doc = await openPdf(filePath);
    await fn(doc, filePath);
  } finally {
    await doc?.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('repeated uppercase phrases retain separate offsets, boxes, and unique issue IDs', async () => {
  await fixturePdf(async (src) => {
    const font = await src.embedFont(StandardFonts.Helvetica);
    const page = src.addPage([600, 800]);
    page.drawText('Here, the part ' + quote, { x: 100, y: 600, size: 12, font });
    page.drawText(quote, { x: 100, y: 400, size: 12, font });
    page.drawText('will complete the figure.', { x: 100, y: 200, size: 12, font });
  }, async (doc) => {
    const layout = await extractPageLayout(doc, 1);
    const text = await extractPageText(doc, 1);
    const issues = [correction()];
    snapIssuesToLayout(issues, layout);
    assert.equal(issues.length, 2);
    assert.equal(new Set(issues.map((issue) => issue.uid)).size, 2);
    assert.notEqual(issues[0].textStart, issues[1].textStart);
    assert.notEqual(issues[0].box.ymin, issues[1].box.ymin);
    for (const issue of issues) {
      assert.equal(issue.boxSource, 'pdf_text');
      assert.equal(text.slice(issue.textStart, issue.textEnd), quote);
      assert.ok(issue.box.ymin < 550, 'already correct lowercase occurrence must not be marked');
      assert.ok(issue.box.xmax - issue.box.xmin < 230, 'partial quote must not highlight the whole sentence');
    }
    snapIssuesToLayout(issues, layout);
    assert.equal(issues.length, 2, 'repeat grounding is idempotent');
  });
});

test('linter offsets select the second occurrence even when placeholder box points above', async () => {
  await fixturePdf(async (src) => {
    const font = await src.embedFont(StandardFonts.Helvetica);
    const page = src.addPage([600, 800]);
    page.drawText(quote, { x: 100, y: 600, size: 12, font });
    page.drawText(quote, { x: 100, y: 400, size: 12, font });
  }, async (doc) => {
    const issue = { ...correction(), textStart: quote.length + 1, source: 'linter', boxSource: 'unverified' };
    const issues = [issue];
    snapIssuesToLayout(issues, await extractPageLayout(doc, 1));
    assert.ok(issue.box.ymin > 450);
    assert.equal(issue.textStart, quote.length + 1);
  });
});

test('bounding boxes transform correctly at 0, 90, 180, and 270 degrees', async () => {
  await fixturePdf(async (src) => {
    const font = await src.embedFont(StandardFonts.Helvetica);
    for (const rotation of [0, 90, 180, 270]) {
      const page = src.addPage([600, 800]);
      page.setRotation(degrees(rotation));
      page.drawText(quote, { x: 100, y: 600, size: 12, font });
    }
  }, async (doc) => {
    for (let pageNumber = 1; pageNumber <= 4; pageNumber++) {
      const issues = [correction()];
      snapIssuesToLayout(issues, await extractPageLayout(doc, pageNumber));
      assert.equal(issues[0].boxSource, 'pdf_text');
      const box = issues[0].box;
      assert.ok(box.xmax > box.xmin && box.ymax > box.ymin);
      if ([2, 4].includes(pageNumber)) assert.ok(box.ymax - box.ymin > box.xmax - box.xmin, 'rotated phrase has vertical bounds');
      else assert.ok(box.xmax - box.xmin > box.ymax - box.ymin);
      assert.ok(Object.values(box).every((value) => value >= 0 && value <= 1000));
    }
  });
});

test('crop origins and rotated text remain inside the visible page', async () => {
  await fixturePdf(async (src) => {
    const font = await src.embedFont(StandardFonts.Helvetica);
    const page = src.addPage([600, 800]);
    page.setCropBox(50, 100, 500, 600);
    page.drawText(quote, { x: 100, y: 400, size: 12, font, rotate: degrees(30) });
  }, async (doc) => {
    const layout = await extractPageLayout(doc, 1);
    assert.equal(layout.length, 4);
    assert.ok(layout.every((item) => item.xmax > item.xmin && item.ymax > item.ymin));
    assert.ok(layout.every((item) => item.xmin >= 0 && item.xmax <= 1000 && item.ymin >= 0 && item.ymax <= 1000));
    assert.ok(layout[3].ymin < layout[0].ymin);
  });
});

test('Tesseract TSV uses image dimensions and excludes malformed or low confidence words', () => {
  const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n' +
    '5\t1\t1\t1\t1\t1\t100\t200\t200\t40\t98\tComplete\n' +
    '5\t1\t1\t1\t1\t2\tNaN\t0\t10\t20\t99\tbroken\n' +
    '5\t1\t1\t1\t1\t3\t20\t20\t20\t20\t10\tuncertain\n';
  const result = parseTesseractTsv(tsv, 2000, 1000);
  assert.equal(result.text, 'Complete');
  assert.deepEqual(result.layoutItems[0], { str: 'Complete', xmin: 50, ymin: 200, xmax: 150, ymax: 240, textStart: 0, textEnd: 8, source: 'ocr_text', confidence: 0.98, blockId:'1', paragraphId:'1', lineId:'1' });
  assert.deepEqual(result.uncertainWords,['uncertain']);
  assert.equal(parseTesseractTsv(tsv, 0, 0).layoutItems.length, 0);
  assert.equal(clampBox({ xmin: NaN, ymin: 0, xmax: 10, ymax: 10 }), null);
});

test('normalization handles superscripts while retaining all occurrence matches', () => {
  assert.deepEqual(tokenizeForLocation('scriptures¹'), ['scriptures', '1']);
  const words = [{ text: quote, x: 10, y: 20, width: 200, height: 20 }, { text: quote, x: 10, y: 220, width: 200, height: 20 }];
  assert.equal(findTextMatches(words, quote).length, 2);
  assert.equal(findTextMatches(words, '999').length, 0);
});

let tesseractAvailable = false;
try { execFileSync(process.env.TESSERACT_CMD || 'tesseract', ['--version'], { stdio: 'ignore', timeout: 3000 }); tesseractAvailable = true; } catch {}
test('scanned PDF performs real OCR and grounds both repeated occurrences', { skip: !tesseractAvailable, timeout: 60000 }, async () => {
  await fixturePdf(async (src) => {
    const canvas = createCanvas(1200, 1600);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1200, 1600);
    ctx.fillStyle = 'black'; ctx.font = '36px sans-serif';
    ctx.fillText(quote, 120, 350); ctx.fillText(quote, 120, 950);
    const image = await src.embedPng(await canvas.encode('png'));
    src.addPage([600, 800]).drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
  }, async (doc) => {
    const evidence = await extractPageEvidence(doc, 1, { language: 'English' });
    assert.equal(evidence.source, 'ocr_text');
    assert.equal(evidence.warning, '');
    assert.equal(evidence.text.split(quote).length - 1, 2);
    const issues = [correction()];
    snapIssuesToLayout(issues, evidence.layoutItems);
    assert.equal(issues.length, 2);
    assert.ok(issues.every((issue) => issue.boxSource === 'ocr_text'));
    assert.ok(Math.abs(issues[0].box.ymin - issues[1].box.ymin) > 300);
  });
});

test('failed PDF opens are evicted so a replacement at the same path can recover', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proofdesk-cache-test-'));
  const filePath = path.join(directory, 'file.pdf');
  try {
    await fs.writeFile(filePath, 'invalid');
    await assert.rejects(withPdf(filePath, (doc) => doc.numPages));
    const src = await PDFDocument.create(); src.addPage();
    await fs.writeFile(filePath, await src.save());
    assert.equal(await withPdf(filePath, (doc) => doc.numPages), 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('ambiguous contextual quotes without evidence remain unverified', () => {
  const layout = [{ str: 'Example 2', xmin: 100, ymin: 100, xmax: 200, ymax: 120, textStart: 0, textEnd: 9 },
    { str: 'Example 2', xmin: 100, ymin: 400, xmax: 200, ymax: 420, textStart: 10, textEnd: 19 }];
  const issues = [{ uid: 'contextual', type: 'examples', quote: 'Example 2', suggestion: 'Example 3' }];
  snapIssuesToLayout(issues, layout);
  assert.equal(issues[0].boxSource, 'unverified');
  assert.equal(issues[0].box, undefined);
  const offsetIssue = [{ uid: 'offset', type: 'examples', quote: 'Example 2', suggestion: 'Example 3', textStart: 90, boxSource: 'unverified' }];
  snapIssuesToLayout(offsetIssue, layout);
  assert.equal(offsetIssue[0].boxSource, 'unverified');
  assert.equal(offsetIssue[0].box, undefined);
  const noText = [{ ...correction() }];
  snapIssuesToLayout(noText, []);
  assert.equal(noText[0].boxSource, 'unverified');
});

test('missing OCR binary uses the JavaScript fallback and leaves a blank page unverified', async () => {
  const previous = process.env.TESSERACT_CMD;
  process.env.TESSERACT_CMD = '/nonexistent-proofdesk-test-tesseract';
  try {
    await fixturePdf(async (src) => { src.addPage([600, 800]); }, async (doc) => {
      const evidence = await extractPageEvidence(doc, 1);
      assert.equal(evidence.text, '');
      assert.equal(evidence.layoutItems.length, 0);
      assert.match(evidence.warning, /scanned text locations remain unverified|some text locations remain unverified/);
    });
  } finally {
    if (previous === undefined) delete process.env.TESSERACT_CMD;
    else process.env.TESSERACT_CMD = previous;
  }
});

test('visual findings retain model evidence and numeric offsets require deterministic provenance', () => {
  const image = { uid: 'figure', type: 'image', quote: '[diagram]', boxSource: 'ai', box: { xmin: 100, ymin: 100, xmax: 200, ymax: 200 } };
  const layout = [{ str: '99', xmin: 450, ymin: 900, xmax: 470, ymax: 920, textStart: 0, textEnd: 2 },
    { str: '99', xmin: 450, ymin: 950, xmax: 470, ymax: 970, textStart: 3, textEnd: 5 }];
  const issues = [image, { uid: 'footer', type: 'page_number', quote: '99', suggestion: '100', textStart: 3, source: 'linter', boxSource: 'unverified' }];
  snapIssuesToLayout(issues, layout);
  assert.equal(image.boxSource, 'ai');
  assert.equal(issues[1].boxSource, 'pdf_text');
  assert.equal(issues[1].box.ymin, 950);
  const ambiguous = [{ uid: 'number', type: 'number', quote: '99', boxSource: 'ai', box: image.box }];
  snapIssuesToLayout(ambiguous, layout);
  assert.equal(ambiguous[0].boxSource, 'unverified');
});

test('case-only corrections cannot ground against already correct lowercase text', () => {
  const issues = [correction()];
  snapIssuesToLayout(issues, [{ str: 'will complete the figure.', xmin: 100, ymin: 100, xmax: 300, ymax: 120, textStart: 0, textEnd: 25 }]);
  assert.equal(issues[0].boxSource, 'unverified');
  assert.equal(issues[0].textStart, undefined);
});

test('punctuation-only edits require the erroneous punctuation, including separate colon items', () => {
  const corrected = [{ uid: 'colon', type: 'punctuation', quote: 'cat: and dog', suggestion: 'cat and dog', boxSource: 'ai', box: { xmin: 100, ymin: 100, xmax: 300, ymax: 120 } }];
  snapIssuesToLayout(corrected, [{ str: 'cat and dog', xmin: 100, ymin: 100, xmax: 300, ymax: 120, textStart: 0, textEnd: 11 }]);
  assert.equal(corrected[0].boxSource, 'unverified');
  const heading = [{ uid: 'heading', type: 'punctuation', quote: 'Note :', suggestion: 'Note:', source: 'linter', textStart: 0, boxSource: 'unverified' }];
  snapIssuesToLayout(heading, [{ str: 'Note', xmin: 100, ymin: 100, xmax: 130, ymax: 120, textStart: 0, textEnd: 4 },
    { str: ':', xmin: 135, ymin: 100, xmax: 140, ymax: 120, textStart: 5, textEnd: 6 }]);
  assert.equal(heading[0].boxSource, 'pdf_text');
  assert.equal(heading[0].textEnd, 6);
  assert.equal(heading[0].box.xmax, 140);
  const curly = [{ uid: 'quotes', type: 'punctuation', quote: '“word”', suggestion: '"word"', boxSource: 'ai', box: { xmin: 100, ymin: 100, xmax: 200, ymax: 120 } }];
  snapIssuesToLayout(curly, [{ str: '"word"', xmin: 100, ymin: 100, xmax: 200, ymax: 120 }]);
  assert.equal(curly[0].boxSource, 'unverified');
});
