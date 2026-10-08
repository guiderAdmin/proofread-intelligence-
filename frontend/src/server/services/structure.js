import { extractPageText } from "./pdf.js";

/**
 * Parses PDF bookmarks and scans front-matter pages (pages 1-15)
 * to build a structured Table of Contents (TOC), Unit, and Chapter map.
 */

export async function extractBookStructure(doc) {
  const structure = {
    toc: [],
    units: [],
    chapters: [],
    pageMap: {},
  };

  const numPages = doc.numPages || 1;

  // 1. Try native PDF outline / bookmarks first
  try {
    const outline = await doc.getOutline();
    if (Array.isArray(outline) && outline.length > 0) {
      const walkOutline = async (items, inheritedUnit = "") => {
        let currentUnit = inheritedUnit;
        for (const item of items) {
          const title = String(item.title || "").trim();
          let pageIndex = null;
          try {
            const destination = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
            if (Array.isArray(destination) && destination[0] !== null && destination[0] !== undefined) {
              const target = destination[0];
              // A destination can contain a reference or a numeric page index,
              // including the first page's valid zero-based index, 0.
              pageIndex = (Number.isInteger(target) ? target : await doc.getPageIndex(target)) + 1;
              if (pageIndex < 1 || pageIndex > numPages) pageIndex = null;
            }
          } catch {
            /* Unresolved bookmark: retain the title without claiming a page. */
          }
          if (/^(?:Unit\b|इकाई)/i.test(title)) {
            currentUnit = title;
            if (!structure.units.includes(title)) structure.units.push(title);
          }
          if (title) structure.toc.push({ title, page: pageIndex, pageNumbering: "pdf", source: "bookmark" });
          const chapter = title.match(/^(?:Chapter|अध्याय)\s*(\d+|[IVXLCDM]+)\s*[:.-]?\s*(.*)$/i);
          if (chapter && pageIndex) {
            structure.chapters.push({ title, number: chapter[1], name: chapter[2], page: pageIndex,
              pageNumbering: "pdf", source: "bookmark", unit: currentUnit });
          }
          if (Array.isArray(item.items) && item.items.length) await walkOutline(item.items, currentUnit);
        }
      };
      await walkOutline(outline);
    }
  } catch {
    /* outline not available or failed */
  }

  // 2. Scan front-matter pages 1 to Math.min(15, numPages) for printed Table of Contents / Index
  const frontPages = Math.min(15, numPages);
  let currentUnit = "";
  for (let p = 1; p <= frontPages; p += 1) {
    try {
      const text = await extractPageText(doc, p);
      if (!text) continue;

      const isTocPage =
        /\b(?:Table\s+of\s+Contents|Contents|INDEX)\b|विषय[ -]सूची/i.test(text);
      // Exercise numbers and ordinary chapter prose are not a printed TOC.
      if (!isTocPage) continue;

      // Parse unit lines: e.g. "Unit 1: Diversity in the Living World" or "इकाई 1"
      const unitMatches = text.match(/(?:Unit|UNIT|इकाई)\s*(\d+|[IVXLCDM]+)[\s:.-]+([A-Za-z0-9\s,\-’'()]+?)(?=(?:Chapter|CHAPTER|Unit|UNIT|इकाई|\d+\.|$))/gi);
      if (unitMatches) {
        for (const u of unitMatches) {
          const cleanU = u.trim();
          if (cleanU && !structure.units.includes(cleanU)) {
            structure.units.push(cleanU);
            currentUnit = cleanU;
          }
        }
      }

      // Parse chapter lines: e.g. "Chapter 1: The Living World ... 1" or "1. The Living World ... 15"
      const chapterLineRegex = /(?:Chapter|CHAPTER|अध्याय)?\s*(\d+)\s*[:.-]\s*([A-Za-z0-9\s,\-’'()]+?)\s*(?:\.{2,}|…)?\s*(\d{1,4})(?=\s*(?:Chapter|CHAPTER|अध्याय|\d+\s*[:.-]|$))/gi;
      let cm;
      while ((cm = chapterLineRegex.exec(text)) !== null) {
        const chNum = parseInt(cm[1], 10);
        const chName = cm[2].trim();
        const startPg = parseInt(cm[3], 10);
        if (chName.length > 2 && startPg > 0) {
          structure.chapters.push({
            number: chNum,
            name: chName,
            page: null,
            printedPage: startPg,
            pageNumbering: "printed",
            source: "printed_toc",
            unit: currentUnit,
          });
          structure.toc.push({
            title: `Chapter ${chNum}: ${chName}`,
            page: null,
            printedPage: startPg,
            pageNumbering: "printed",
            source: "printed_toc",
            unit: currentUnit,
          });
        }
      }
    } catch {
      /* ignore page text error */
    }
  }

  // Deduplicate TOC entries
  const seen = new Set();
  structure.toc = structure.toc.filter((item) => {
    const key = `${item.title}-${item.pageNumbering}-${item.page ?? item.printedPage}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return structure;
}

/**
 * Returns contextual Unit, Chapter, and TOC summary for a given page number.
 */
export function getPageContextFromStructure(structure, pageNumber) {
  if (!structure) {
    return {
      expectedUnit: "",
      expectedChapter: "",
      tocSummary: "",
    };
  }

  // Find chapter covering pageNumber
  // Printed page labels often start after cover/front matter. Legacy stored
  // chapters have no numbering provenance and are equally unsafe to map.
  const sorted = (Array.isArray(structure.chapters) ? structure.chapters : [])
    .filter((chapter) => chapter.pageNumbering === "pdf" && Number.isInteger(chapter.page) && chapter.page > 0)
    .sort((a, b) => a.page - b.page);
  let matchedChapter = null;
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].page && sorted[i].page <= pageNumber) {
      matchedChapter = sorted[i];
    } else if (sorted[i].page && sorted[i].page > pageNumber) {
      break;
    }
  }

  const expectedChapter = matchedChapter ? matchedChapter.title || `Chapter ${matchedChapter.number}: ${matchedChapter.name}` : "";
  const expectedUnit = matchedChapter?.unit || "";
  const tocSummary = (Array.isArray(structure.toc) ? structure.toc : [])
    .slice(0, 10)
    .map((t) => t.pageNumbering === "pdf"
      ? `${t.title} (PDF pg ${t.page || "?"})`
      : `${t.title} (printed pg ${t.printedPage ?? t.page ?? "?"}; PDF position unverified)`)
    .join("; ");

  return {
    expectedUnit,
    expectedChapter,
    tocSummary,
  };
}
