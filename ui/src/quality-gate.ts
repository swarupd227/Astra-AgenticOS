/**
 * The document quality gate on files: what a developer's own tool (Claude Code, a CI job) calls to have a requirements
 * document checked against the documents it was written from. It runs the same checks as the web app (doc-gate.ts) and
 * needs no API key and no project: files in, findings out. quality-mcp.ts serves it over MCP and as a command.
 */
import fs from "node:fs";
import path from "node:path";
import { GoldenStore } from "./golden.js";
import { implausiblyShort } from "./guards.js";
import { clientDocumentMap, sourceChecks, type NamedSource } from "./doc-gate.js";
import {
  citationIssues, citationKey, constructsProhibitedBy, fieldRowsAsLabels, formatCitationReport, formatConflicts,
  formatProhibited, formatUncheckedDocuments, itemLedger, noCheckableCitations, ownDocuments, prohibitedUsed,
  reviewableBlocks, summarizeItemLedger, termConflicts, unaddressedConflicts,
} from "./source-checks.js";
import { REVIEW_SYSTEM } from "./source-review.js";
import { COVERAGE_SYSTEM } from "./source-coverage.js";

export type GateOptions = {
  /** Every path is read from inside this folder and nowhere else. */
  root: string;
  /** Golden Repository folder, for documents that cite GLD ids. Unset: such citations are reported as unreadable. */
  goldenDir?: string;
  /** When set, the only Golden items that may be read. */
  goldenItems?: string[];
};

export type GateInput = { document: string; sources: string[]; taskFile?: string };

export type GateResult = {
  /** Findings that need action or an explanation. */
  findings: string[];
  /** What was said for information: what could not be checked, and counts. */
  information: string[];
  text: string;
};

const TEXT_FILE = /\.(?:md|txt)$/i;

function inside(root: string, p: string): string {
  const full = path.resolve(root, p);
  // Through links too: a link inside the folder that points out of it is outside.
  const real = fs.existsSync(full) ? fs.realpathSync(full) : full;
  const rel = path.relative(fs.realpathSync(root), real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${p} is outside ${root}; the gate only reads files inside it`);
  return full;
}

function read(root: string, p: string): string {
  const full = inside(root, p);
  if (!fs.existsSync(full)) throw new Error(`${p} does not exist under ${root}`);
  return fs.readFileSync(full, "utf8");
}

/** The source files named, folders expanded to the Markdown and text files directly in them. */
function sourceFiles(root: string, sources: string[]): string[] {
  const out: string[] = [];
  for (const s of sources) {
    const full = inside(root, s);
    if (!fs.existsSync(full)) throw new Error(`${s} does not exist under ${root}`);
    if (fs.statSync(full).isDirectory()) {
      for (const f of fs.readdirSync(full).sort()) if (TEXT_FILE.test(f) && fs.statSync(path.join(full, f)).isFile()) out.push(path.join(s, f));
    } else if (TEXT_FILE.test(s)) out.push(s);
    else throw new Error(`${s} is not a .md or .txt file; convert it to Markdown first`);
  }
  if (!out.length) throw new Error("no source files: give the .md or .txt documents the requirements were written from");
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The checks know a client document as `inputs/<name>`. Files elsewhere in a repository are given that name, and the
 * document's own ways of citing them (the path, or the file name in backticks) are read as it.
 */
export function asInputs(doc: string, files: string[]): { doc: string; names: string[] } {
  const names: string[] = [];
  const base = (f: string) => path.basename(f);
  for (const f of files) {
    const name = `inputs/${base(f).replace(/[\s,;()[\]]+/g, "-")}`;
    if (names.some((n) => n.toLowerCase() === name.toLowerCase())) throw new Error(`two sources are both cited as ${name}; rename one`);
    names.push(name);
  }
  let out = doc;
  // Longest first, so "docs/spec.md" is replaced before the bare "spec.md" inside it.
  const forms = files.flatMap((f, i) => {
    const rel = f.replace(/\\/g, "/").replace(/^\.\//, "");
    return [
      ...(rel.includes("/") ? [{ re: new RegExp(`(?<![\\w/.-])(?:\\./)?${escape(rel)}`, "gi"), to: names[i], len: rel.length }] : []),
      { re: new RegExp(`(?<=[\`“"(])${escape(base(f))}(?=[\`”")\\s,;:—–])`, "gi"), to: names[i], len: base(f).length },
    ];
  }).sort((a, b) => b.len - a.len);
  for (const x of forms) out = out.replace(x.re, x.to);
  return { doc: out, names };
}

function gather(opts: GateOptions, input: GateInput) {
  const files = sourceFiles(opts.root, input.sources);
  const task = input.taskFile ? read(opts.root, input.taskFile) : "";
  const raw = input.document ? read(opts.root, input.document) : "";
  const { doc: content, names } = asInputs(raw, files);
  const documentPath = input.document ? inside(opts.root, input.document) : "";
  if (files.some((f) => inside(opts.root, f) === documentPath)) throw new Error("the document is also listed as one of its sources");
  const allSources: NamedSource[] = [{ name: "task prompt", text: task }, ...files.map((f, i) => ({ name: names[i], text: read(opts.root, f) }))];
  return { content, task, allSources };
}

export function checkDocument(opts: GateOptions, input: GateInput): GateResult {
  if (!input.document) throw new Error("name the document to check");
  const { content, task, allSources } = gather(opts, input);
  const findings: string[] = [];
  const information: string[] = [];

  const cited = new Map<string, string>();
  if (task) cited.set(citationKey("task prompt"), task);
  for (const s of allSources.slice(1)) cited.set(citationKey(s.name), s.text);

  // Golden Repository items the document cites, read only from the folder and ids allowed.
  const ids = [...new Set((content.match(/GLD-[A-Z]+-\d+/gi) ?? []).map((x) => x.toUpperCase()))];
  if (ids.length) {
    const store = opts.goldenDir && fs.existsSync(path.join(opts.goldenDir, "index.json")) ? new GoldenStore(opts.goldenDir) : null;
    const unread: string[] = [];
    for (const id of ids) {
      const allowed = !opts.goldenItems || opts.goldenItems.includes(id);
      const item = allowed ? store?.get(id) : undefined;
      const text = item && item.status === "published" ? store!.readContent(id) : null;
      if (item && text) { cited.set(citationKey(id), text); allSources.push({ name: `${id} (${item.title})`, text }); }
      else unread.push(id);
    }
    if (unread.length)
      findings.push(`⚠ **Golden Repository citations that could not be read — ${unread.length}:** ${unread.slice(0, 12).join(", ")}${unread.length > 12 ? ", …" : ""}. They are not checked (no repository folder set, not published, or not selected).`);
  }

  const doc = fieldRowsAsLabels(content);
  const short = implausiblyShort(content.length);
  if (short) findings.push(short);
  const prohibited = formatProhibited(prohibitedUsed(content, constructsProhibitedBy(task)));
  if (prohibited) findings.push(prohibited);

  const requirements = reviewableBlocks(doc).length;
  if (requirements < 3)
    findings.push(`⚠ **Fewer than three requirements were recognised**, so the checks made per requirement have little or nothing to read. The gate reads items headed with an ID (\`#### REQ-001 — Name\`) with **Requirement Statement:** and **Source Reference:** fields.`);

  const report = citationIssues(doc, cited, new Map(task ? [["task prompt", task]] : []));
  const citations = formatCitationReport(report) ?? noCheckableCitations(report, content.length);
  if (citations) findings.push(citations);

  for (const note of sourceChecks({ doc, cited, allSources, whole: true, length: content.length }))
    (note.startsWith("ℹ") ? information : findings).push(note);

  const own = new Set(ownDocuments(allSources).filter((s) => s.text).map((s) => s.name));
  const open = unaddressedConflicts(content, termConflicts(allSources.filter((s) => s.text), 0.4, (n) => own.has(n)));
  if (open.length)
    findings.push(`⚠ **Terms the sources define in unlike words, not recorded as a conflict:** ${open.map((t) => `“${t}”`).join(", ")}. Record each as a **Source Conflict Identified** with both wordings quoted, or say it is not a real conflict.`);

  const ledger = itemLedger(doc, clientDocumentMap(allSources));
  const unchecked = formatUncheckedDocuments(ledger);
  if (unchecked) information.push(unchecked);

  const text = [
    findings.length ? `**Quality gate: ${findings.length} finding${findings.length === 1 ? "" : "s"} to fix or explain.**` : `**Quality gate: no findings.**`,
    `${requirements} requirements read against ${allSources.length - 1} source document${allSources.length === 2 ? "" : "s"}${task ? " and the task" : " (no task file given, so citations of the task prompt are not checked)"}. ${summarizeItemLedger(ledger)}.`,
    ...findings,
    ...information,
    `These checks compare wording; passing them does not show the document is right. Not run here: template conformance, and an independent reader (call \`review_instructions\` and give them to a reviewer that did not write the document).`,
  ].join("\n\n");
  return { findings, information, text };
}

export function compareSources(opts: GateOptions, input: Omit<GateInput, "document">): string {
  const { allSources } = gather(opts, { ...input, document: "" });
  const present = allSources.filter((s) => s.text);
  const own = new Set(ownDocuments(present).map((s) => s.name));
  return `Compared ${present.length} sources.\n\n${formatConflicts(termConflicts(present, 0.4, (n) => own.has(n)))}`;
}

/** What to hand a second reader, for tools that can start one of their own (a Claude Code subagent). */
export function reviewInstructions(): string {
  return [
    `Give the text below to a reviewer that did not write the document (in Claude Code, a new subagent), with the paths of the document, its source documents and the task. Do not tell it what you expect it to find. It reports; you decide what to change.`,
    `## Reviewing the requirements against their sources\n\nRead every source to its end before judging.\n\n${REVIEW_SYSTEM.replace(/- Account for every requirement[\s\S]*$/, "- Account for every requirement: list those with problems with their quotes and fixes, then the IDs of those with none.")}`,
    `## Reading source documents that have no headings\n\nUse this for each source the gate says it could not check item by item.\n\n${COVERAGE_SYSTEM.replace("You are given a digest of its requirements (ID, name, statement) and then one part of a client document that has no section headings.", "Read the requirements, then the client document that has no section headings.")}`,
  ].join("\n\n");
}
