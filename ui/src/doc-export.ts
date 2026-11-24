/**
 * Export a Markdown deliverable (a BRD, an ADR) as a Word document or a print-ready page for PDF.
 *
 * The Markdown these agents write is a small, regular subset: headings, paragraphs, bullet and numbered lists, pipe
 * tables, block quotes, rules, and inline bold, italics, code and links. It is read into blocks once and written out
 * two ways: as a .docx built with JSZip (already a dependency; no Word or LibreOffice on the server), and as a styled
 * HTML page the browser prints to PDF (the server has no PDF engine, and a browser's "Save as PDF" keeps tables intact).
 */
import JSZip from "jszip";

export type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string };
export type Block =
  | { type: "heading"; level: number; runs: Inline[] }
  | { type: "paragraph"; runs: Inline[] }
  | { type: "list"; ordered: boolean; items: { depth: number; runs: Inline[] }[] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] }
  | { type: "quote"; runs: Inline[] }
  | { type: "rule" };

/** Bold, italics, code spans and links within one line of text. Anything else stays as written. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\[[^\]]+\]\((?:https?:|mailto:)[^)\s]+\))|((?<![\w*])\*[^*\n]+\*(?![\w*]))|((?<![\w_])_[^_\n]+_(?![\w_]))/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push({ text: s.slice(last, m.index) });
    const t = m[0];
    if (m[1]) out.push({ text: t.slice(1, -1), code: true });
    else if (m[2] || m[3]) out.push(...parseInline(t.slice(2, -2)).map((r) => ({ ...r, bold: true })));
    else if (m[4]) { const l = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!; out.push({ text: l[1], href: l[2] }); }
    else out.push(...parseInline(t.slice(1, -1)).map((r) => ({ ...r, italic: true })));
    last = m.index! + t.length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out.filter((r) => r.text.length);
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const isTableSep = (l: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => parseInline(c.trim().replace(/\\\|/g, "|")));

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^\s*```/.test(l)) { // a fenced block keeps its lines as written
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push({ type: "paragraph", runs: [{ text: body.join("\n"), code: true }] });
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) { out.push({ type: "heading", level: h[1].length, runs: parseInline(h[2]) }); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push({ type: "rule" }); i++; continue; }
    if (l.trim().startsWith("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(l);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(cells(lines[i]));
      out.push({ type: "table", head, rows });
      continue;
    }
    if (LIST.test(l)) {
      const ordered = /^\s*\d+[.)]\s+/.test(l);
      const items: { depth: number; runs: Inline[] }[] = [];
      const raw: { depth: number; text: string }[] = [];
      while (i < lines.length && (LIST.test(lines[i]) || (raw.length && /^\s{2,}\S/.test(lines[i]) && !LIST.test(lines[i])))) {
        const m = LIST.exec(lines[i]);
        if (m) raw.push({ depth: Math.min(2, Math.floor(m[1].replace(/\t/g, "    ").length / 2)), text: m[3] });
        else raw[raw.length - 1].text += " " + lines[i].trim();
        i++;
      }
      for (const r of raw) items.push({ depth: r.depth, runs: parseInline(r.text) });
      out.push({ type: "list", ordered, items });
      continue;
    }
    if (l.startsWith(">")) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) { q.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push({ type: "quote", runs: parseInline(q.join(" ")) });
      continue;
    }
    const p: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|>|\s*\|)/.test(lines[i]) && !LIST.test(lines[i])) { p.push(lines[i].trim()); i++; }
    out.push({ type: "paragraph", runs: parseInline(p.length ? p.join(" ") : l.trim()) });
    if (!p.length) i++;
  }
  return out;
}

// --- HTML for printing to PDF -----------------------------------------------------------------------------

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const runsHtml = (runs: Inline[]) => runs.map((r) => {
  let t = escHtml(r.text).replace(/\n/g, "<br>");
  if (r.code) t = `<code>${t}</code>`;
  if (r.bold) t = `<strong>${t}</strong>`;
  if (r.italic) t = `<em>${t}</em>`;
  if (r.href && /^(https?:|mailto:)/.test(r.href)) t = `<a href="${escHtml(r.href)}">${t}</a>`;
  return t;
}).join("");

/** A self-contained page laid out for A4, which opens the browser's print dialog so the reader can save it as PDF. */
export function toPrintHtml(blocks: Block[], title: string): string {
  const body = blocks.map((b) => {
    switch (b.type) {
      case "heading": return `<h${b.level}>${runsHtml(b.runs)}</h${b.level}>`;
      case "paragraph": return `<p>${runsHtml(b.runs)}</p>`;
      case "quote": return `<blockquote>${runsHtml(b.runs)}</blockquote>`;
      case "rule": return "<hr>";
      case "list": { const t = b.ordered ? "ol" : "ul"; return `<${t}>${b.items.map((it) => `<li style="margin-left:${it.depth * 18}px">${runsHtml(it.runs)}</li>`).join("")}</${t}>`; }
      case "table": return `<table><thead><tr>${b.head.map((c) => `<th>${runsHtml(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${runsHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(title)}</title><style>
@page { size: A4; margin: 18mm 16mm; }
body { font-family: "Segoe UI", Calibri, Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #1d2420; max-width: 820px; margin: 24px auto; padding: 0 16px; }
.bar { position: sticky; top: 0; background: #f4f6f5; border: 1px solid #d5dcd8; border-radius: 6px; padding: 10px 14px; margin-bottom: 18px; display: flex; gap: 12px; align-items: center; font-size: 10pt; }
.bar button { font: inherit; padding: 6px 12px; border-radius: 5px; border: 1px solid #1f6f5c; background: #1f6f5c; color: #fff; cursor: pointer; }
h1 { font-size: 20pt; margin: 0 0 8pt; } h2 { font-size: 14.5pt; margin: 18pt 0 6pt; border-bottom: 1px solid #c9d1cc; padding-bottom: 3pt; }
h3 { font-size: 12pt; margin: 14pt 0 5pt; } h4, h5, h6 { font-size: 10.5pt; margin: 10pt 0 4pt; } h1, h2, h3, h4 { break-after: avoid; }
p { margin: 0 0 6pt; } ul, ol { margin: 0 0 6pt; padding-left: 18pt; } li { margin: 0 0 2pt; }
table { border-collapse: collapse; width: 100%; margin: 4pt 0 10pt; font-size: 9pt; } tr { break-inside: avoid; }
th, td { border: 1px solid #c9d1cc; padding: 3pt 5pt; vertical-align: top; text-align: left; } th { background: #eef2ef; }
code { font-family: Consolas, "Courier New", monospace; font-size: 8.8pt; background: #f1f3f2; padding: 0 2pt; white-space: pre-wrap; }
blockquote { margin: 0 0 6pt; padding: 4pt 8pt; border-left: 3px solid #c9d1cc; color: #4a554f; } hr { border: 0; border-top: 1px solid #c9d1cc; margin: 10pt 0; }
@media print { .bar { display: none; } body { margin: 0; max-width: none; padding: 0; } }
</style></head><body>
<div class="bar"><button type="button" onclick="window.print()">Save as PDF</button><span>In the print dialog, choose "Save as PDF" as the destination.</span></div>
${body}
<script>window.addEventListener("load", () => setTimeout(() => window.print(), 300));</script>
</body></html>`;
}

// --- Word (.docx) ----------------------------------------------------------------------------------------

const escXml = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function runsXml(runs: Inline[], base: { bold?: boolean } = {}): string {
  return runs.map((r) => {
    const props = [
      r.bold || base.bold ? "<w:b/>" : "",
      r.italic ? "<w:i/>" : "",
      r.code ? `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/>` : "",
      r.href ? `<w:color w:val="1F6F5C"/><w:u w:val="single"/>` : "",
    ].join("");
    const parts = r.text.split("\n").map((t) => `<w:t xml:space="preserve">${escXml(t)}</w:t>`).join("<w:br/>");
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${parts}</w:r>`;
  }).join("");
}

const para = (runs: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`;
const PAGE_DXA = 9638; // A4 width less 1.8 cm side margins, in twentieths of a point

function blocksXml(blocks: Block[]): string {
  return blocks.map((b) => {
    switch (b.type) {
      case "heading": return para(runsXml(b.runs), `<w:pStyle w:val="Heading${Math.min(b.level, 4)}"/>`);
      case "paragraph": return para(runsXml(b.runs));
      case "quote": return para(runsXml(b.runs), `<w:pStyle w:val="Quote"/>`);
      case "rule": return para("", `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C9D1CC"/></w:pBdr>`);
      case "list": return b.items.map((it) => para(runsXml(it.runs),
        `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${it.depth}"/><w:numId w:val="${b.ordered ? 2 : 1}"/></w:numPr>`)).join("");
      case "table": {
        const n = Math.max(b.head.length, ...b.rows.map((r) => r.length), 1);
        const w = Math.floor(PAGE_DXA / n);
        const cell = (c: Inline[] | undefined, head: boolean) =>
          `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${head ? `<w:shd w:val="clear" w:color="auto" w:fill="EEF2EF"/>` : ""}</w:tcPr>${para(runsXml(c ?? [], { bold: head }), `<w:spacing w:after="0"/>`)}</w:tc>`;
        const row = (r: Inline[][], head: boolean) => `<w:tr>${head ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${Array.from({ length: n }, (_, k) => cell(r[k], head)).join("")}</w:tr>`;
        return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${w * n}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>` +
          `<w:tblGrid>${`<w:gridCol w:w="${w}"/>`.repeat(n)}</w:tblGrid>${row(b.head, true)}${b.rows.map((r) => row(r, false)).join("")}</w:tbl>${para("")}`;
      }
    }
  }).join("");
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="1D2420"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="100"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="C9D1CC"/></w:pBdr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="1F6F5C"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="21"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="C9D1CC"/></w:pBdr></w:pPr><w:rPr><w:color w:val="4A554F"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>
<w:top w:val="single" w:sz="4" w:space="0" w:color="C9D1CC"/><w:left w:val="single" w:sz="4" w:space="0" w:color="C9D1CC"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="C9D1CC"/><w:right w:val="single" w:sz="4" w:space="0" w:color="C9D1CC"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="C9D1CC"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="C9D1CC"/>
</w:tblBorders><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style>
</w:styles>`;

const level = (ilvl: number, fmt: string, text: string, indent: number) =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${indent}" w:hanging="300"/></w:pPr>${fmt === "bullet" ? `<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>` : ""}</w:lvl>`;
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0">${[0, 1, 2].map((d) => level(d, "bullet", "", 360 + d * 360)).join("")}</w:abstractNum>
<w:abstractNum w:abstractNumId="1">${[0, 1, 2].map((d) => level(d, ["decimal", "lowerLetter", "lowerRoman"][d], `%${d + 1}.`, 360 + d * 360)).join("")}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

/** A .docx of the blocks: Word's own heading styles (so the navigation pane and a table of contents work), real lists and tables. */
export async function toDocx(blocks: Block[], title: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escXml(title)}</dc:title></cp:coreProperties>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`);
  zip.file("word/styles.xml", STYLES);
  zip.file("word/numbering.xml", NUMBERING);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocksXml(blocks)}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1021" w:right="1134" w:bottom="1021" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// --- Golden Repository citations, as a reader sees them ---------------------------------------------------

export type GoldenInfo = { title: string; path?: string; version?: number | string };

/**
 * The document as a reader sees it: "GLD-REF-139@1" is how writers cite a Golden Repository item, so every check can
 * verify it, but to a reader it is an internal key and a version marker. Each becomes a short label, "GR-139" (with its
 * kind, "GR-REF-139", only where two kinds share a number), titled where nothing names it already
 * ("(GLD-REF-139@1)" → "(GR-139: Glossary)"; "(GLD-REF-139@1, Glossary)" → "(GR-139, Glossary)"), and a table at the end
 * gives each label's title, repository path and version. The stored document is unchanged: this is for the viewer
 * and the downloads only.
 */
export function presentGoldenCitations(md: string, info: (id: string) => GoldenInfo | undefined): string {
  const re = /\bGLD-([A-Z]+)-(\d+)(?:@(\d+))?\b/g;
  const cited = new Map<string, { kind: string; num: string; version?: string }>();
  for (const m of md.matchAll(re)) {
    const id = `GLD-${m[1]}-${m[2]}`;
    if (!cited.has(id)) cited.set(id, { kind: m[1], num: m[2], version: m[3] });
  }
  if (!cited.size) return md;
  const kindsByNum = new Map<string, Set<string>>();
  for (const c of cited.values()) kindsByNum.set(c.num, new Set([...(kindsByNum.get(c.num) ?? []), c.kind]));
  const label = (kind: string, num: string) => ((kindsByNum.get(num)?.size ?? 0) > 1 ? `GR-${kind}-${num}` : `GR-${num}`);
  const out = md.replace(re, (whole, kind: string, num: string, _v, offset: number, s: string) => {
    const l = label(kind, num);
    const title = info(`GLD-${kind}-${num}`)?.title;
    // Title it only where the citation stands alone: before a closing bracket, a semicolon, the end of a sentence or line.
    const next = s.slice(offset + whole.length, offset + whole.length + 2);
    return title && /^(?:[)\];]|\.(?:\s|$)|\s*$|$)/.test(next) && !/^\s*\|/.test(next) ? `${l}: ${title}` : l;
  });
  const rows = [...cited.entries()]
    .sort((a, b) => Number(a[1].num) - Number(b[1].num))
    .map(([id, c]) => {
      const i = info(id);
      return `| ${label(c.kind, c.num)} | ${(i?.title ?? "Not found in the Golden Repository").replace(/\|/g, "\\|")} | ${i?.path ? `\`${i.path}\`` : "Not recorded"} | ${i?.version ?? c.version ?? "Not recorded"} |`;
    });
  return `${out.replace(/\s+$/, "")}\n\n## Golden Repository references\n\n| Ref | Title | Repository path | Version |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n`;
}

/** The title to give an exported document: its first heading, else the file name. */
export function documentTitle(blocks: Block[], fallback: string): string {
  const h = blocks.find((b) => b.type === "heading");
  return h && h.type === "heading" ? h.runs.map((r) => r.text).join("").trim() || fallback : fallback;
}
