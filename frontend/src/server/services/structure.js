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
      for (const item of outline) {
        const title = (item.title || "").trim();
        if (!title) continue;
        let pageIndex = null;
        if (typeof item.dest === "string") {
          try {
            const dest = await doc.getDestination(item.dest);
            if (dest && dest[0]) {
              pageIndex = (await doc.getPageIndex(dest[0])) + 1;
            }
          } catch {
            /* ignore */
          }
        } else if (Array.isArray(item.dest) && item.dest[0]) {
          try {
            pageIndex = (await doc.getPageIndex(item.dest[0])) + 1;
          } catch {
            /* ignore */
          }
        }
        structure.toc.push({
          title,
          page: pageIndex,
        });
      }
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
        /\b(?:Table\s+of\s+Contents|Contents|INDEX|Index|विषय-सूची|विषय सूची)\b/i.test(text);
      if (!isTocPage && structure.toc.length === 0 && p > 6) {
        continue;
      }

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
      const chapterLineRegex = /(?:Chapter|CHAPTER|अध्याय)?\s*(\d+)\s*[:.-]\s*([A-Za-z0-9\s,\-’'()]+?)\s*(\d{1,4})(?=\s+(?:Chapter|CHAPTER|अध्याय|\d+\s*[:.-]|$))/gi;
      let cm;
      while ((cm = chapterLineRegex.exec(text)) !== null) {
        const chNum = parseInt(cm[1], 10);
        const chName = cm[2].trim();
        const startPg = parseInt(cm[3], 10);
        if (chName.length > 2 && startPg > 0 && startPg <= numPages) {
          structure.chapters.push({
            number: chNum,
            name: chName,
            page: startPg,
            unit: currentUnit,
          });
          structure.toc.push({
            title: `Chapter ${chNum}: ${chName}`,
            page: startPg,
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
    const key = `${item.title}-${item.page}`;
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
  if (!structure || !structure.chapters?.length) {
    return {
      expectedUnit: "",
      expectedChapter: "",
      tocSummary: "",
    };
  }

  // Find chapter covering pageNumber
  const sorted = [...structure.chapters].sort((a, b) => (a.page || 0) - (b.page || 0));
  let matchedChapter = null;
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].page && sorted[i].page <= pageNumber) {
      matchedChapter = sorted[i];
    } else if (sorted[i].page && sorted[i].page > pageNumber) {
      break;
    }
  }

  const expectedChapter = matchedChapter ? `Chapter ${matchedChapter.number}: ${matchedChapter.name}` : "";
  const expectedUnit = matchedChapter?.unit || "";
  const tocSummary = structure.toc
    .slice(0, 10)
    .map((t) => `${t.title} (pg ${t.page || "?"})`)
    .join("; ");

  return {
    expectedUnit,
    expectedChapter,
    tocSummary,
  };
}
