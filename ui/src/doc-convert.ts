/**
 * Turns an uploaded Word or PDF document into Markdown suitable for the Golden
 * Repository.
 *
 * Two things drive the design:
 *
 *  1. **Clause structure is the product.** Agents cite what they follow as
 *     `id@version` and point at a clause ("under 4.1.2"). A conversion that
 *     produces one wall of text is technically successful and practically
 *     useless, so we preserve headings and report when we could not.
 *
 *  2. **Nothing is trusted.** The file type is decided by magic bytes, never by
 *     the filename, and the extracted text is scanned for content that reads as
 *     instructions to an AI rather than as policy. That is reported to the admin
 *     before they publish, because golden content is data an agent reads — it
 *     must never become a channel for telling agents what to do.
 */
import mammoth from "mammoth";
import TurndownService from "turndown";
import { extractText, getDocumentProxy } from "unpdf";

export type DocKind = "docx" | "pdf";

export interface ConvertResult {
  kind: DocKind;
  markdown: string;
  warnings: string[];
  stats: { chars: number; headings: number; pages?: number };
}

/** Decide the format from the bytes. A .docx renamed to .pdf must not be believed. */
export function sniffKind(buf: Buffer): DocKind | null {
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  // OOXML is a zip; .docx specifically contains word/document.xml.
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    return buf.includes(Buffer.from("word/document.xml")) ? "docx" : null;
  }
  return null;
}

/**
 * Phrases that mean "this document is trying to steer an agent", not "this
 * document states a rule". Deliberately narrow — a false positive here costs an
 * admin ten seconds of reading, a false negative puts instructions in an agent's
 * context wearing the authority of a bank standard.
 */
const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|prompts)\b/i, "tells the reader to ignore previous instructions"],
  [/\byou\s+are\s+(now\s+)?(an?\s+)?(AI|assistant|language model|chatbot)\b/i, "addresses the reader as an AI assistant"],
  [/\b(system|developer)\s+prompt\b/i, "refers to a system or developer prompt"],
  [/\bdisregard\s+(the\s+)?(rules|guardrails|policy|restrictions)\b/i, "tells the reader to disregard rules"],
  [/\b(jailbreak|prompt\s+injection|DAN\s+mode)\b/i, "mentions jailbreaking or prompt injection"],
  [/\bdo\s+not\s+(tell|inform|mention\s+to)\s+the\s+user\b/i, "asks the reader to withhold information from the user"],
];

function scanForInjection(text: string): string[] {
  const hits: string[] = [];
  for (const [re, why] of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const at = Math.max(0, m.index - 40);
      hits.push(`${why} — near: "${text.slice(at, m.index + m[0].length + 40).replace(/\s+/g, " ").trim()}"`);
    }
  }
  return hits;
}

function turndown(): TurndownService {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  // Word tables carry real policy (rate tables, RACI grids). Turndown drops them
  // by default; a naive pipe-table keeps the content readable and citable.
  td.addRule("table", {
    filter: "table",
    replacement: (_c, node) => {
      const rows = Array.from((node as HTMLTableElement).querySelectorAll("tr"));
      if (!rows.length) return "";
      const cells = (tr: Element) =>
        Array.from(tr.querySelectorAll("th,td")).map((c) => (c.textContent || "").replace(/\s+/g, " ").trim());
      const head = cells(rows[0]);
      const body = rows.slice(1).map(cells);
      const line = (xs: string[]) => `| ${xs.join(" | ")} |`;
      return ["", line(head), line(head.map(() => "---")), ...body.map(line), ""].join("\n");
    },
  });
  return td;
}

async function convertDocx(buf: Buffer): Promise<ConvertResult> {
  const warnings: string[] = [];
  const { value: html, messages } = await mammoth.convertToHtml({ buffer: buf });
  for (const m of messages) {
    // Unrecognised styles are the common case and usually harmless; surface only
    // what could change meaning.
    if (m.type === "error") warnings.push(`Word conversion: ${m.message}`);
  }
  let md = turndown().turndown(html);
  md = tidy(md);

  const headings = countHeadings(md);
  if (headings === 0)
    warnings.push(
      "No headings were found. Word only produces headings if the document uses real Heading styles — " +
        "if this document numbers its clauses with hand-typed bold text, agents can still read it but cannot cite a section. " +
        "Adding `## 1. Title` lines makes citations precise."
    );
  if (/^\s*\d+\.\s/m.test(md) === false && /\b\d+\.\d+(\.\d+)?\b/.test(md) === false)
    warnings.push(
      "No clause numbering (like 4.1.2) survived. Word's automatic list numbering is generated at display time " +
        "and is not stored as text, so it cannot be extracted. Type the numbers into the headings if you need agents to cite clauses."
    );
  return { kind: "docx", markdown: md, warnings, stats: { chars: md.length, headings } };
}

async function convertPdf(buf: Buffer): Promise<ConvertResult> {
  const warnings: string[] = [];
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  let md = tidy(String(text ?? ""));

  if (!md.trim())
    warnings.push(
      "No text could be extracted. This is almost certainly a scanned PDF — the pages are images, not text. " +
        "Run it through OCR (or export the original document as PDF again) before loading it here. " +
        "Saving it as-is would create an empty standard that agents silently find nothing in."
    );
  else if (hasNumberedClauses(md)) {
    // Search already treats a line starting "4.1.2 " as a citable position, so a
    // numbered policy needs no Markdown headings to be citable. Say that plainly
    // rather than sending someone off to hand-edit forty pages for nothing.
    warnings.push(
      "PDFs carry no heading information, but this document numbers its clauses — agents can still cite a " +
        "precise clause (for example 4.1.2), so no hand-editing is needed. Adding `#` headings would only " +
        "make the section titles nicer to read."
    );
  } else {
    warnings.push(
      "PDFs carry no heading information, and no clause numbering was found either. The text is complete, but " +
        "agents will only be able to cite this document as a whole. Adding `## Section` lines, or numbering the " +
        "clauses, makes citations precise."
    );
  }
  if (md.trim() && /[a-z],?\n[a-z]/.test(md))
    warnings.push("Line breaks follow the PDF's page layout, so some sentences may be split across lines. Worth a skim before publishing.");
  return { kind: "pdf", markdown: md, warnings, stats: { chars: md.length, headings: countHeadings(md), pages: totalPages } };
}

const countHeadings = (md: string) => (md.match(/^#{1,6}\s+\S/gm) || []).length;

/** Does the text carry numbered clauses (4.1.2 …) that search can cite as-is? */
const hasNumberedClauses = (s: string) => /^\s*\d+(\.\d+)+\s+\S/m.test(s) || /^\s*\d+\.\s+\S/m.test(s);

/** Collapse the whitespace noise both converters produce, without touching content. */
function tidy(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    // Turndown escapes the dot in "1. Purpose" so Markdown won't read it as a list.
    // Correct, but it leaves "1\. Purpose" in a bank standard — and the clause number
    // is exactly what people cite, so it has to read cleanly.
    .replace(/(^|\s)(\d+(?:\.\d+)*)\\\./g, "$1$2.")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ /g, " ")
    .trim();
}

export async function convertDocument(buf: Buffer, filename: string): Promise<ConvertResult> {
  const kind = sniffKind(buf);
  if (!kind) {
    const ext = (filename.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
    if (ext === ".doc")
      throw new Error(
        "This is a legacy .doc file (Word 97–2003), which cannot be read directly. " +
          "Open it in Word and use Save As → .docx, then upload that."
      );
    throw new Error(
      `Could not recognise "${filename}" as a Word (.docx) or PDF file from its contents. ` +
        "Only .docx and .pdf are supported here — for anything else, paste the text into the content box."
    );
  }

  const result = kind === "docx" ? await convertDocx(buf) : await convertPdf(buf);

  const injection = scanForInjection(result.markdown);
  for (const hit of injection)
    result.warnings.push(
      `SECURITY — this document contains text that reads as an instruction to an AI, not as policy: ${hit}. ` +
        "Golden content is data agents read, never commands they obey, but you should confirm this text belongs here before publishing."
    );

  return result;
}
