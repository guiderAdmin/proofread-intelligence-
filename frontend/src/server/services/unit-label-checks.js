import crypto from "node:crypto";
import { findTextMatches } from "../../lib/text-geometry.js";

/** Correct this compound unit label without singularising chapter "Patterns". */
export function lintUnitLabels(items = []) {
  const words=items.map(w=>({...w,text:w.str,x:w.xmin,y:w.ymin,width:w.xmax-w.xmin,height:w.ymax-w.ymin}));
  return findTextMatches(words,"Patterns Recognition",{caseSensitive:true,literalOnly:true}).filter(match=>
    items.some(w=>/^Unit(?:[-:]?\d+[:.]?)?$/i.test(w.str) && Math.abs(w.ymin-match.box.ymin)<15 && w.xmin<match.box.xmin) &&
    !items.some(w=>w.source==="ocr_text" && w.confidence<.8 && w.textStart>=match.textStart && w.textEnd<=match.textEnd))
    .map(match=>({uid:crypto.randomUUID(),type:"wording",severity:"minor",quote:"Patterns Recognition",suggestion:"Pattern Recognition",
      explanation:"In this unit label, 'pattern' modifies 'recognition': use 'Pattern Recognition' consistently. The standalone chapter title 'Patterns' is valid and remains plural.",
      source:"linter",status:"open",confidence:.98,box:match.box,boxSource:match.source,textStart:match.textStart,textEnd:match.textEnd}));
}
