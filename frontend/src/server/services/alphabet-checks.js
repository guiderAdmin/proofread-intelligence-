import crypto from "node:crypto";

/** Check alternating alphabet arrows only when the printed explanation and
 * independently measured letter sequence corroborate the same rule. */
export function lintAlphabetSteps(items = []) {
  const findings = [];
  for (const anchor of items.filter(w => /^Alphabet$/i.test(w.str))) {
    const left = anchor.xmin < 500 ? 0 : 500;
    const region = items.filter(w => w.xmin >= left && w.xmax <= left + 500 &&
      w.ymin > anchor.ymax && w.ymax < anchor.ymax + 160);
    const ordered = [...region].sort((a,b) => Math.round(a.ymin/12)-Math.round(b.ymin/12) || a.xmin-b.xmin);
    const prose = ordered.map(w=>w.str).join(" ");
    const rule = prose.match(/Move\s+(\d+)\s+letters?\s+forward,?\s+then\s+(\d+)\s+letters?\s+backward/i);
    if (!rule) continue;
    const forward = Number(rule[1]), backward = -Number(rule[2]);
    const labels = region.filter(w=>/^[+−-]\d+$/.test(w.str) && (w.source!=="ocr_text" || w.confidence>=.85));
    if (labels.length!==4 || Math.max(...labels.map(w=>w.ymin))-Math.min(...labels.map(w=>w.ymin))>10) continue;
    labels.sort((a,b)=>a.xmin-b.xmin);
    const letters = region.filter(w=>/^[A-Z?]$/.test(w.str) && w.ymin<labels[0].ymin &&
      w.ymin>labels[0].ymin-55).sort((a,b)=>a.xmin-b.xmin);
    // Exclude the answer box above the common sequence baseline.
    const baseline = Math.max(...letters.map(w=>w.ymin));
    const sequence = letters.filter(w=>Math.abs(w.ymin-baseline)<8);
    if(sequence.length!==5 || sequence.slice(0,4).some(w=>!/^[A-Z]$/.test(w.str)))continue;
    if(sequence.slice(0,3).some((w,i)=>sequence[i+1].str.charCodeAt(0)-w.str.charCodeAt(0)!==(i%2 ? backward:forward)))continue;
    for(let i=0;i<labels.length;i++) {
      const expected = i%2 ? backward:forward;
      const label=labels[i];
      if(Number(label.str.replace("−","-"))===expected)continue;
      findings.push({uid:crypto.randomUUID(),type:"number",severity:"major",quote:label.str,
        suggestion:expected>0 ? `+${expected}`:String(expected),
        explanation:`The alphabet pattern alternates ${forward} letters forward and ${Math.abs(backward)} letter(s) backward. Arrow ${i+1} must show ${expected>0 ? "+":""}${expected}; its printed label contradicts the explanation and measured letter sequence.`,
        source:"linter",status:"open",confidence:.96,boxSource:label.source,
        box:{xmin:label.xmin,ymin:label.ymin,xmax:label.xmax,ymax:label.ymax},textStart:label.textStart,textEnd:label.textEnd});
    }
  }
  return findings;
}
