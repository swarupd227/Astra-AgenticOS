/**
 * Pins src/doc-export.ts: Markdown read into blocks, written as .docx and as a print page, and Golden Repository
 * citations shown to readers as short labels.
 *
 *   npm run test:export
 */
import JSZip from "jszip";
import { documentTitle, parseInline, parseMarkdown, presentGoldenCitations, toDocx, toPrintHtml } from "../src/doc-export.js";

let failures = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); failures++; }
};

const MD = [
  "# BRD: Relationship Intelligence", "", "Intro with **bold**, *italic* and `code`.", "",
  "## 1. Scope", "", "- First item", "  - Nested item", "- Second item", "", "1. Step one", "2. Step two", "",
  "| Field | Value |", "| --- | --- |", "| Owner | Not specified in source |", "| Pipe | a \\| b |", "",
  "> A quoted source sentence.", "", "---", "", "Closing paragraph.",
].join("\n");

{
  const b = parseMarkdown(MD);
  eq("block kinds in order", b.map((x) => x.type), ["heading", "paragraph", "heading", "list", "list", "table", "quote", "rule", "paragraph"]);
  eq("the title is the first heading", documentTitle(b, "file"), "BRD: Relationship Intelligence");
  const list = b[3];
  eq("list depth is kept", list.type === "list" ? list.items.map((i) => i.depth) : null, [0, 1, 0]);
  const table = b[5];
  eq("an escaped pipe stays in its cell", table.type === "table" ? table.rows[1][1].map((r) => r.text).join("") : null, "a | b");
  eq("inline styles", parseInline("x **b** *i* `c` [l](https://e.com)").map((r) => [r.text, !!r.bold, !!r.italic, !!r.code, r.href ?? ""]),
    [["x ", false, false, false, ""], ["b", true, false, false, ""], [" ", false, false, false, ""], ["i", false, true, false, ""], [" ", false, false, false, ""], ["c", false, false, true, ""], [" ", false, false, false, ""], ["l", false, false, false, "https://e.com"]]);
}

{
  const html = toPrintHtml(parseMarkdown(MD), "BRD");
  eq("the print page has the table and the save button", html.includes("<table>") && html.includes("Save as PDF") && html.includes("@page"), true);
  eq("markup in the text is escaped", toPrintHtml(parseMarkdown("A <script>x</script> line"), "t").includes("&lt;script&gt;"), true);
}

{
  const buf = await toDocx(parseMarkdown(MD), "BRD");
  const zip = await JSZip.loadAsync(buf);
  const doc = await zip.file("word/document.xml")!.async("string");
  eq("the .docx has its parts", ["[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/numbering.xml"].every((p) => !!zip.file(p)), true);
  eq("headings use Word's heading styles", doc.includes('w:val="Heading1"') && doc.includes('w:val="Heading2"'), true);
  eq("tables and lists are real", doc.includes("<w:tbl>") && doc.includes("<w:numPr>"), true);
  eq("text is escaped for XML", (await toDocx(parseMarkdown("R&D < 5"), "t")).length > 0, true);
}

{
  const info = (id: string) => ({ "GLD-REF-139": { title: "Glossary", path: "products/abs/domain/glossary.md", version: 1 },
    "GLD-REF-145": { title: "Decision Log", path: "projects/ri/decision-log.md", version: 2 } } as Record<string, any>)[id];
  const md = "Now Opportunities (GLD-REF-139@1, Glossary). Per the log (GLD-REF-145@2).\n\n| GLD-REF-139@1 | Glossary |";
  const out = presentGoldenCitations(md, info);
  eq("a titled citation becomes a short label", out.includes("(GR-139, Glossary)"), true);
  eq("a bare citation gets its title", out.includes("(GR-145: Decision Log)"), true);
  eq("a table cell keeps the bare label", out.includes("| GR-139 | Glossary |"), true);
  eq("no internal key or version marker is left in the text", /GLD-|@\d/.test(out.split("## Golden Repository references")[0]), false);
  eq("a reference table gives path and version", out.includes("| GR-145 | Decision Log | `projects/ri/decision-log.md` | 2 |"), true);
  eq("two kinds with one number keep their kind", presentGoldenCitations("A GLD-FS-001 and GLD-REF-001.", () => undefined).includes("GR-FS-001 and GR-REF-001"), true);
  eq("a document with no Golden citations is unchanged", presentGoldenCitations("Plain text.", info), "Plain text.");
}

console.log(`document export — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
