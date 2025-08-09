// src/services/chunking.ts
// What: Heading-aware Markdown chunking.
// How: Splits by headings (#, ##, ###), then paragraphs (blank-line delimited). Long paragraphs are split
//      by simple sentence heuristics. Packs adjacent pieces into ~6000-7500 char chunks retaining headings.

const MAX_PARA_LEN = 1200;
const TARGET = 7000;
const MIN = 6000;
const MAX = 7500;

export function chunkMarkdown(md: string): string[] {
  const sections = toSections(md);
  const pieces: string[] = [];

  for (const sec of sections) {
    const paras = toParagraphs(sec);
    for (const p of paras) {
      if (p.length <= MAX_PARA_LEN) {
        pieces.push(p);
      } else {
        splitBySentences(p).forEach((s) => {
          if (s.trim().length > 0) pieces.push(s.trim());
        });
      }
    }
  }

  // Pack pieces into chunks ~ TARGET
  const chunks: string[] = [];
  let buf = '';
  for (const piece of pieces) {
    if (buf.length === 0) {
      buf = piece;
      continue;
    }
    const join = buf + '\n\n' + piece;
    if (join.length <= MAX) {
      buf = join;
    } else if (buf.length >= MIN) {
      chunks.push(buf);
      buf = piece;
    } else {
      // Can't fit; push buf and start new
      chunks.push(buf);
      buf = piece;
    }
  }
  if (buf.trim().length > 0) chunks.push(buf);
  return chunks;
}

function toSections(md: string): string[] {
  const lines = md.split(/\r?\n/);
  const sections: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    const isHeading = /^(#{1,3})\s+/.test(line);
    if (isHeading) {
      // Commit previous section
      if (cur.length > 0) {
        sections.push(cur.join('\n').trim());
        cur = [];
      }
      cur.push(line); // retain heading
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) sections.push(cur.join('\n').trim());
  return sections.filter((s) => s.length > 0);
}

function toParagraphs(section: string): string[] {
  const parts = section.split(/\n\s*\n/);
  return parts.map((p) => p).filter((x) => x.trim().length > 0);
}

function splitBySentences(paragraph: string): string[] {
  const sentences = paragraph.split(/(?<=[\.\!\?])\s+/);
  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + ' ' + s).trim().length <= MAX_PARA_LEN) {
      buf = (buf ? buf + ' ' : '') + s.trim();
    } else {
      if (buf) out.push(buf);
      buf = s.trim();
    }
  }
  if (buf) out.push(buf);
  return out;
}