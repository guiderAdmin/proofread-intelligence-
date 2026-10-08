import crypto from "node:crypto";

/** Only observed PDF positions may create chapter boundaries. Printed TOC labels remain separate. */
export function structureFromEvidence(base, pages, pageCount) {
  const candidates=(base?.chapters||[]).filter(c=>c.source!=="book_fallback" && c.source!=="front_matter" && c.pageNumbering==="pdf").map(c=>({...c}));
  const units=new Set(base?.units||[]), toc=[...(base?.toc||[])];
  const unitHeaders = [];
  const orderedPages = [...pages].sort((a,b)=>a.pageNumber-b.pageNumber);
  const isContents = page => /\b(?:contents|table of contents|index)\b/i.test(String(page.structuredText||page.textExtract||"").slice(0,1000));
  for(const page of orderedPages) {
    const text=String(page.structuredText||page.textExtract||"");
    for(const line of text.split(/\n/)) {
      const match=line.replace(/^[|¦\s]+/, "").match(/^(Unit|Chapter|Ch\.?)[ \t-]*(\d+)\s*[:.\-–—]\s*([^.!?]{2,80})$/i);
      if(!match)continue;
      if(page.textLayout?.length && !page.textLayout.some(w=>w.ymin<330 && /^(?:unit|chapter|ch)/i.test(w.str)))continue;
      const number=Number(match[2]),name=match[3].trim();
      const unit=/^unit$/i.test(match[1]) ? `Unit ${number}: ${name}`:"";
      if(unit)units.add(unit);
      if(isContents(page)) continue;
      if(unit) {
        unitHeaders.push({page:page.pageNumber,number,unit});
        if(unitHeaders.some(header=>header!==unitHeaders.at(-1) && header.number===number))continue;
      }
      if(!candidates.some(c=>c.page===page.pageNumber && c.name===name))candidates.push({number,name,page:page.pageNumber,unit,
        confidence:unit ? .55 : .8,source:unit?"unit_heading":"body_heading",pageNumbering:"pdf"});
      if(!toc.some(t=>t.page===page.pageNumber && t.title===name))toc.push({title:name,page:page.pageNumber,pageNumbering:"pdf",source:"observed_heading",unit});
    }
    if(isContents(page)) {
      // OCR often reads the title and printed-page columns as separate blocks.
      // Pair their measured baselines instead of requiring a complete text line.
      const items=page.textLayout||[];
      for(const label of items.filter(w=>w.xmin>700 && /^\d{1,3}$/.test(w.str) && !(w.source==="ocr_text" && w.confidence<.8))) {
        const middle=(label.ymin+label.ymax)/2;
        const row=items.filter(w=>w.xmin>=100 && w.xmax<label.xmin-30 &&
          Math.abs((w.ymin+w.ymax)/2-middle)<Math.max(8,(label.ymax-label.ymin)*.6) &&
          !(w.source==="ocr_text" && w.confidence<.8)).sort((a,b)=>a.xmin-b.xmin);
        const title=row.map(w=>w.str).join(" ").replace(/^\d+[.:]?\s+/,"").trim();
        if(title.length<3 || /^(?:Unit|Chapter|Ch[.])\b/i.test(title))continue;
        const numberWord=items.find(w=>w.xmin<100 && /^\d+[.:]?$/.test(w.str) && Math.abs((w.ymin+w.ymax)/2-middle)<10);
        const number=numberWord ? Number(numberWord.str.replace(/\D/g,"")) : 0;
        if(!toc.some(t=>t.title.toLowerCase()===title.toLowerCase() && t.printedPage===Number(label.str)))
          toc.push({number,title,printedPage:Number(label.str),page:null,pageNumbering:"printed",source:"printed_toc"});
      }
      for(const line of text.split(/\n/)) {
        const match=line.match(/^\s*(\d+)\s*[.:\-]?\s+(.{3,70}?)\s+(\d{1,3})\s*$/);
        if(match && !toc.some(t=>t.title===match[2] && t.printedPage===Number(match[3])))
          toc.push({number:Number(match[1]),title:match[2].trim(),printedPage:Number(match[3]),page:null,pageNumbering:"printed",source:"printed_toc"});
      }
    }
  }
  // Only the observed opener supplies a PDF position; TOC labels stay separate.
  for(const page of orderedPages) {
    if(isContents(page))continue;
    const items=page.textLayout||[], rows=new Map();
    for(const word of items) {
      const key=word.lineId ? `${word.blockId}:${word.paragraphId}:${word.lineId}` : `${Math.round(word.ymin/10)}:${word.xmin<500}`;
      if(!rows.has(key))rows.set(key,[]);rows.get(key).push(word);
    }
    const heights=items.map(w=>w.ymax-w.ymin).filter(h=>h>0).sort((a,b)=>a-b), median=heights[Math.floor(heights.length/2)]||15;
    for(const words of rows.values()) {
      words.sort((a,b)=>a.xmin-b.xmin);
      const text=words.map(w=>w.str).join(" ").replace(/^[|¦\s]+/, "").trim();
      const entry=toc.find(t=>t.source==="printed_toc" && t.title.toLowerCase()===text.toLowerCase());
      if(!entry || Math.min(...words.map(w=>w.ymin))>330 ||
        Math.min(...words.map(w=>w.ymax-w.ymin))<median*1.4 ||
        words.some(w=>w.source==="ocr_text" && w.confidence<.8))continue;
      if(candidates.some(c=>c.name.toLowerCase()===text.toLowerCase() && c.source==="toc_opener"))continue;
      const unit=unitHeaders.filter(h=>h.page<=page.pageNumber).at(-1)?.unit||"";
      candidates.push({number:entry.number||0,name:text,page:page.pageNumber,unit,confidence:.95,source:"toc_opener",pageNumbering:"pdf"});
    }
  }
  const byPage=new Map();for(const candidate of candidates)if(!byPage.has(candidate.page) || candidate.confidence>byPage.get(candidate.page).confidence)byPage.set(candidate.page,candidate);
  let chapters=[...byPage.values()].sort((a,b)=>a.page-b.page);
  if(!chapters.length || chapters[0].page>1)chapters.unshift({number:0,name:chapters.length?"Front matter":"Unclassified content",page:1,confidence:.2,source:chapters.length?"front_matter":"book_fallback",pageNumbering:"pdf"});
  chapters=chapters.map((chapter,i)=>({...chapter,startPage:chapter.page,endPage:chapters[i+1]?chapters[i+1].page-1:pageCount,
    chapterKey:`chapter-${chapter.page}-${String(chapter.name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,"-").slice(0,70)}`}));
  const pageMap={};for(const chapter of chapters)for(let n=chapter.startPage;n<=chapter.endPage;n++)pageMap[n]=chapter.chapterKey;
  const indexedPages=pages.filter(p=>p.evidenceIndexed || String(p.textExtract||"").length>=180).map(p=>p.pageNumber);
  const evidenceHash=crypto.createHash("sha256").update(JSON.stringify(orderedPages.map(page=>[
    page.pageNumber,Boolean(page.evidenceIndexed),page.structuredText||page.textExtract||""]))).digest("hex");
  return {...base,chapters,units:[...units],toc,pageMap,indexedPages,evidenceHash,status:indexedPages.length<pageCount?"partial":chapters.some(c=>c.confidence<.6 && c.source!=="front_matter")?"degraded":"ready",analysisVersion:"chapter-context-v2"};
}

export function localChapterContext(chapter,pages,pageNumber,maxChars=7000) {
  const indexed=pages.filter(p=>p.pageNumber>=chapter.startPage && p.pageNumber<=chapter.endPage && (p.evidenceIndexed || String(p.textExtract||"").length>=180));
  const total=chapter.endPage-chapter.startPage+1;
  const share=Math.max(100,Math.floor((maxChars-400)/Math.max(1,indexed.length)));
  const selected=[...indexed].sort((a,b)=>Math.abs(a.pageNumber-pageNumber)-Math.abs(b.pageNumber-pageNumber));
  return `Chapter: ${chapter.name}; observed PDF pages ${chapter.startPage}-${chapter.endPage}; boundary confidence ${chapter.confidence}.\nExtracted evidence covers ${indexed.length}/${total} chapter pages. ${indexed.length<total?"PARTIAL CONTEXT: do not claim every chapter page was examined.":"Every chapter page has extracted evidence; the following bounded excerpts are source facts, not a complete semantic summary."}\n`+
    selected.map(p=>`[PDF page ${p.pageNumber}] ${String(p.structuredText||p.textExtract||"").slice(0,share)}`).join("\n").slice(0,maxChars-400);
}
