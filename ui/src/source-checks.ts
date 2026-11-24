/**
 * Checks for deliverables written from source documents (a BRD from requirement
 * documents, rather than from code).
 *
 * Each one is a deterministic comparison made after the fact and reported back to the
 * agent while it can still fix the artifact — the shape that has held up here, as
 * opposed to instructions in a persona, which the live runs showed being overridden.
 * All pure functions, so the lines they draw can be tested directly.
 *
 * They are heuristics over text and say so: a citation score is "does the cited text
 * contain this wording", not "is the claim true".
 */

// --- shared text helpers ----------------------------------------------------------

const STOP = new Set(
  ("shall system must should would could which their there these those being when then with from that this have " +
   "been also only each every such other into upon within where while both more than used uses using user users " +
   "will can may might the and for are was were not but any all per via its they them").split(" ")
);

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);
export const contentWords = (s: string) => words(s).filter((w) => !STOP.has(w) && w.length >= 3);
/** Crude stemming: first five letters, so "billing" and "billed" meet. */
export const stem = (w: string) => (w.length > 5 ? w.slice(0, 5) : w);

function bigramList(ws: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < ws.length; i++) out.push(`${stem(ws[i])} ${stem(ws[i + 1])}`);
  return out;
}
const bigramSet = (text: string) => new Set(bigramList(contentWords(text)));

/** Strip markdown emphasis and list markers so patterns see plain prose. */
const plain = (s: string) => s.replace(/[*_`]+/g, "").replace(/^\s*(?:[-+>]|\d+[.)])\s+/, "").trim();

// --- 1. Citation support -----------------------------------------------------------

/** Minimum claim bigrams for a score to mean anything. Shorter claims are skipped. */
const MIN_BIGRAMS = 4;
/** Below this the cited text does not contain the wording. Calibrated against a reviewer's
 *  ground truth: supported citations scored 0.76-0.78, misattributed ones 0.06-0.20. */
export const NOT_FOUND_BELOW = 0.3;
export const WEAK_BELOW = 0.5;

const CITE = /GLD-[A-Z]+-\d+(?:@\d+)?|inputs\/[^\s,;)\]*]+\.(?:md|txt)|\btask prompt(?=\s*[—–]|\s+-\s|\s*:\s*[“\"])/gi;

/** Whether the document cites the task prompt as a source ("task prompt — …"), so it must be loaded to be checked against. */
export function citesTaskPrompt(content: string): boolean {
  return (content.match(CITE) ?? []).some((c) => citationKey(c) === "task prompt");
}

/** The distinct sources a piece of text cites, as keys into the map of source texts. */
export function citedKeys(text: string): string[] {
  return [...new Set((text.match(CITE) ?? []).map(citationKey))];
}

/**
 * A client document a requirements document is written from: an uploaded input, or a functional specification held in the
 * Golden Repository (`GLD-FS-002@1 (Client Sprint 2 - Detailed Requirements)`). Takes a source name or a citation key.
 * Standards, templates and reference items are material to cite, never documents requirements come from.
 */
export function isClientDocument(name: string): boolean {
  return /^inputs\//i.test(name) || /^GLD-FS-\d+\b/i.test(name);
}

/**
 * The task and the client's own documents among the sources: the uploaded inputs when the project has any — Golden
 * Repository items, functional specs included, then stay reference material — otherwise its GLD-FS functional specs.
 */
export function ownDocuments<T extends { name: string }>(all: T[]): T[] {
  const inputs = all.some((s) => /^inputs\//i.test(s.name));
  return all.filter((s) => s.name === "task prompt" || (inputs ? /^inputs\//i.test(s.name) : isClientDocument(s.name)));
}

/**
 * Sources that were asked for but cannot be used, each with why: an input that cannot be read or is empty; a Golden
 * Repository item selected for the project (by id) that is missing, not published, or has no readable content; an item
 * the task names that the project has not selected. Without this a run worked on less than it was given and said nothing.
 */
export function degradedSources(s: {
  inputs: { path: string; text: string | null }[];
  selected: { id: string; title: string; status: string; content: string | null }[];
  selectedIds: string[];
  task: string;
}): string[] {
  const out: string[] = [];
  for (const f of s.inputs) {
    if (f.text === null) out.push(`${f.path}: could not be read`);
    else if (!f.text.trim()) out.push(`${f.path}: is empty`);
  }
  const byId = new Map(s.selected.map((i) => [i.id.toUpperCase(), i]));
  for (const i of s.selected)
    if (i.status === "published" && !(i.content ?? "").trim()) out.push(`${i.id} (${i.title}): selected, but its content could not be read`);
  for (const id of s.selectedIds) {
    const i = byId.get(id.toUpperCase());
    if (!i) out.push(`${id}: selected for this project, but no such item is available`);
    else if (i.status !== "published") out.push(`${i.id} (${i.title}): selected, but it is ${i.status}, not published`);
  }
  const named = new Set((s.task.match(/\bGLD-[A-Z]+-\d+\b/gi) ?? []).map((x) => x.toUpperCase()));
  for (const id of named) if (!byId.has(id)) out.push(`${id}: named in the task, but not selected for this project`);
  return [...new Set(out)];
}

export function formatDegradedSources(d: string[]): string | null {
  return d.length
    ? `⚠ **Sources asked for but not used — ${d.length}:**\n${d.map((x) => `- ${x}`).join("\n")}\nThe document was written without them. Say so in the document, or ask the user to fix the source.`
    : null;
}

/** `GLD-FS-001@1` and `gld-fs-001` are the same citation. */
export function citationKey(c: string): string {
  return /^gld-/i.test(c) ? c.replace(/@\d+$/, "").toUpperCase() : c.toLowerCase();
}

export type CitationIssue = {
  kind: "not-found" | "weak";
  citation: string;
  claim: string;
  score: number;
  /** Another available source whose wording matches, when there is one. */
  foundIn?: string;
};

export type CitationReport = { checked: number; unverifiable: number; issues: CitationIssue[] };

type Unit = { text: string; claim: string };

/** A line that opens an identified item: `REQ-012`, `**BR-3**`, `- OQ-07 …`. */
const ID_LED = /^\s*(?:[-*]\s+)?\**[A-Z]{1,4}-\d{1,4}\b/;

/**
 * Claim-plus-citation units. A `**Label:** ...` run is one unit (a requirement and its
 * source reference sit on adjacent lines); anything else is one line (a rule with its
 * citation at the end, or a table row).
 */
function citationUnits(md: string): Unit[] {
  const units: Unit[] = [];
  const lines = md.split("\n");
  const labelled = /^\s*\*\*[^*\n]+:\*\*/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^#{1,6}\s/.test(line) || /^-{3,}\s*$/.test(line)) continue;
    if (labelled.test(line)) {
      // The fields of one requirement: on adjacent lines, or — as agents write them — with a blank line between
      // each, and the value sometimes on the line after a label that stands alone. Read line by line, the
      // statement and its Source Reference were separate units and the statement was compared with nothing.
      const segs: { label: string; body: string[] }[] = [];
      let j = i;
      for (;;) {
        const lm = /^\s*\*\*([^*\n]+):\*\*\s*(.*)$/.exec(lines[j])!;
        const seg = { label: lm[1].trim(), body: lm[2] ? [lm[2]] : [] };
        if (!lm[2]) {
          while (j + 1 < lines.length && lines[j + 1].trim() && !labelled.test(lines[j + 1]) && !/^#{1,6}\s/.test(lines[j + 1]) &&
            !/^\s*(?:[-*+]\s|\d+[.)]\s)/.test(lines[j + 1]) && !ID_LED.test(lines[j + 1])) seg.body.push(lines[++j]);
        }
        segs.push(seg);
        let k = j + 1;
        while (k < lines.length && !lines[k].trim()) k++;
        // A label seen twice means the next requirement has begun.
        if (k < lines.length && labelled.test(lines[k]) && !segs.some((s) => s.label.toLowerCase() === /^\s*\*\*([^*\n]+):\*\*/.exec(lines[k])![1].trim().toLowerCase())) j = k;
        else break;
      }
      const stmt = segs.find((s) => /^(?:requirement )?statement$/i.test(s.label));
      if (stmt) {
        i = j;
        // Priority, Dependencies and Open Questions cite their own sources and are checked as their own lines. A Source
        // Conflict line quotes the other source on purpose (its quotes are checked verbatim by quoteIssues): counted here,
        // the statement was "not found" in the source it is said to conflict with (held-out acme run, 2026-11-21).
        const own = (s: { label: string }) => /priority|dependenc|open question|source conflict/i.test(s.label);
        const text = segs.filter((s) => !own(s)).map((s) => `**${s.label}:** ${s.body.join(" ")}`).join("\n");
        units.push({ text, claim: plain(stmt.body.join(" ")) });
        continue;
      }
      // Other labelled blocks (context, inputs and outputs, stakeholders) are prose a field at a time: only lines
      // that sit together form a unit. Joining their fields made one long claim that matched nothing.
      const block = [line];
      while (i + 1 < lines.length && labelled.test(lines[i + 1])) block.push(lines[++i]);
      // A Source Conflict line on its own sets two sources' words side by side: no single source holds both.
      if (/^\s*\*\*Source Conflict/i.test(line) && block.length === 1) continue;
      units.push({ text: block.join("\n"), claim: plain(block.filter((l) => !/Source|Priority|Dependenc|Open Question/i.test(l)).join(" ").replace(/^\s*\*\*[^*]+:\*\*/, "")) });
      continue;
    }
    // `REQ-001 — statement` with its `*Source: …*` and notes on the lines below: one unit.
    // Treated line by line, the source line became its own "claim" — a quoted source checked
    // against itself — and the statement above it was never compared with anything.
    if (ID_LED.test(line)) {
      const block = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^#{1,6}\s/.test(lines[i + 1]) && !ID_LED.test(lines[i + 1]) && !labelled.test(lines[i + 1]))
        block.push(lines[++i]);
      const head = line.replace(/^\s*(?:[-*]\s+)?\**[A-Z]{1,4}-\d{1,4}\**\s*[—–:.-]*\s*/, "");
      const cut = head.search(CITE);
      units.push({ text: block.join("\n"), claim: plain(cut > 0 ? head.slice(0, cut) : head) });
      continue;
    }
    // Claim = what precedes the first citation; when nothing does, the line without them.
    const firstCite = line.search(CITE);
    const before = firstCite > 0 ? plain(line.slice(0, firstCite)) : "";
    units.push({ text: line, claim: bigramList(contentWords(before)).length >= MIN_BIGRAMS ? before : plain(line.replace(CITE, " ")) });
  }
  return units;
}

/**
 * Does each cited source contain the wording of the claim it is cited for?
 *
 * Single-word overlap is useless here — against a 100K-character document nearly every
 * claim scores ~1.0 — so this uses adjacent word pairs: a claim that merely uses
 * vocabulary found in the source scores low, one that reproduces its phrasing scores high.
 * `sources` are the texts the artifact may cite; `others` are labelled texts that are
 * not cited but could be (the task prompt), used only to say where wording actually came from.
 */
const ABSENCE_OR_INFERENCE = /\b(?:(?:is|are|was|were)\s+not\s+(?:specified|stated|named|defined|provided|given|described|identified|documented)\b|not\s+specified\s+in\s+(?:the\s+)?source|no\s+source\s+(?:states|names|defines|gives|describes)|the\s+sources?\s+(?:do|does)\s+not\b|(?:is|are)\s+inferred\b|inferred\s+from\b|this\s+document\s+(?:reads|infers|interprets)\b|(?:the\s+)?document's\s+(?:own\s+)?(?:reading|interpretation|inference))/i;

// Tested after a trailing "(" is cut: "The system shall X (`inputs/a.md`)" leaves "…X (", a claim like any other.
const LEAD_IN = /(?:\b(?:of|from|in|by|per|to|see|at|under)|[:,])\s*$/i;
const PROVENANCE = /\b(?:are|is|were|was)\s+(?:drawn|taken|carried|derived|sourced)\s+from\b|\bcomes?\s+from\b|\bas entered in\b/i;
const OWN_QUESTION = /^\s*(?:[-*+]\s+|\d+[.)]\s+|\|\s*)?(?:\*\*)?(?:OQ|Q|GAP|ISSUE|SC)-?\d+\b|^\s*(?:[-*+]\s+|\d+[.)]\s+|\|\s*)?(?:\*\*)?Whether\b/i;

export function citationIssues(
  artifact: string, sources: Map<string, string>, others: Map<string, string> = new Map()
): CitationReport {
  const sets = new Map<string, Set<string>>();
  const setFor = (k: string, m: Map<string, string>) => {
    if (!sets.has(k)) sets.set(k, bigramSet(m.get(k) ?? ""));
    return sets.get(k)!;
  };
  const report: CitationReport = { checked: 0, unverifiable: 0, issues: [] };

  for (const u of citationUnits(artifact)) {
    const cites = [...new Set((u.text.match(CITE) ?? []).map(citationKey))];
    if (!cites.length) continue;
    // A sentence that says the source is silent, or that labels itself as the document's own reading, attributes
    // nothing to the source; checking its wording against the source can only fail. Run 25's writer spent 24 patches
    // on "This role name is not specified in the source documents. It is inferred from the activities described in …".
    if (ABSENCE_OR_INFERENCE.test(u.claim)) continue;
    // A sentence that says where content comes from, its citation its object ("Technical requirements come from the
    // Constraints field of `inputs/…`:"), or a lead-in to the list or table that follows, attributes nothing itself:
    // with its citations cut away it ends "…field of", "…designs," or "( , Glossary):", and on a Kinective BRD such lines
    // were most of 94 "not found" citations. The items under it are units of their own and are checked.
    // A trailing "Source:" label is how a claim introduces its own citation ("… billing. Source: inputs/a.md"), not a lead-in.
    const tail = u.claim.replace(/[\s*_`(]+$/, "").replace(/\b(?:sources?|source references?|ref(?:erence)?)\s*:\s*$/i, "").replace(/[\s*_`(]+$/, "");
    if (LEAD_IN.test(tail.replace(/\(\s*[,;\s]*\)\s*:?$/, ":")) || /:\s*[*_]*\s*$/.test(u.text.split("\n").pop() ?? "")) continue;
    // The same for a sentence about provenance ("Data requirements are drawn from the Golden Repository data items"),
    // and for an open question or gap: the document's own question, not wording it attributes to the source.
    if (PROVENANCE.test(u.claim) || OWN_QUESTION.test(u.text)) continue;
    // A statement that is itself a recorded conflict quotes two sources side by side; its quotes are checked verbatim.
    if (/^\s*source conflict identified\b/i.test(u.claim)) continue;
    const claimBigrams = bigramList(contentWords(u.claim));
    if (claimBigrams.length < MIN_BIGRAMS) continue;

    // A claim with several citations is supported when one of them holds its wording; the others are context
    // ("TECH-02 … (form, Constraints; GLD-REF-135, BR-19; GLD-REF-141)"). Reported against each of the others, one
    // well-cited row became three "not found" findings.
    const score = (c: string) => claimBigrams.filter((b) => setFor(c, sources).has(b)).length / claimBigrams.length;
    const known = cites.filter((c) => sources.has(c));
    const supported = known.length > 1 && known.some((c) => score(c) >= WEAK_BELOW);
    for (const c of cites) {
      if (!sources.has(c)) { report.unverifiable++; continue; }
      report.checked++;
      const s = score(c);
      if (s >= WEAK_BELOW || supported) continue;
      const scoreOf = s;

      let foundIn: string | undefined;
      for (const [label] of others) {
        const s = claimBigrams.filter((b) => setFor("other:" + label, new Map([["other:" + label, others.get(label)!]])).has(b)).length / claimBigrams.length;
        if (s >= 0.6) { foundIn = label; break; }
      }
      report.issues.push({
        kind: scoreOf < NOT_FOUND_BELOW ? "not-found" : "weak",
        citation: c, claim: u.claim.replace(/\s+/g, " ").slice(0, 140), score: +scoreOf.toFixed(2), ...(foundIn ? { foundIn } : {}),
      });
    }
  }
  return report;
}

/**
 * Every hard miss is listed (up to `max`), then a few weak ones. The first version showed six
 * and "…and 42 more": the agent could not fix what it could not see, and a live run ended with
 * the misses still open after six saves.
 */
export function formatCitationReport(r: CitationReport, max = 40): string | null {
  const hard = r.issues.filter((i) => i.kind === "not-found");
  if (!hard.length && !r.issues.length) return null;
  const shown = [...hard.slice(0, max), ...r.issues.filter((i) => i.kind === "weak").slice(0, 5)];
  const lines = shown.map(
    (i) => `- \`${i.citation}\` ${i.kind === "not-found" ? "does not appear to contain" : "only weakly matches"} “${i.claim}” (wording overlap ${Math.round(i.score * 100)}%)` +
      (i.foundIn ? ` — this wording is found in the ${i.foundIn}; cite that instead.` : "")
  );
  return (
    `⚠ **Citation check — ${hard.length} of ${r.checked} cited claims are not in the source they cite** (${r.issues.length - hard.length} more match only weakly):\n` +
    lines.join("\n") +
    (r.issues.length > shown.length ? `\n- …and ${r.issues.length - shown.length} more.` : "") +
    `\nThis compares the claim's wording with the cited text; it does not judge whether the claim is true. Fix each citation or reword the claim, then save again.`
  );
}

// --- 0. A requirement written as a table is read like one written as labelled lines --------------

const FIELD_LABEL = /^(?:requirement (?:id|name|statement|description)|statement|description|source(?: reference)?s?|priority|dependenc(?:y|ies)|open questions?|rationale|notes?)$/i;

/**
 * Requirement fields in a two-column table (`| Dependencies | REQ-044 — … |`) become labelled lines
 * (`**Dependencies:** REQ-044 — …`), which is what every check below reads. A live run wrote all 95
 * requirements as `| Field | Detail |` tables: the dependency, citation and strength checks found nothing
 * to look at, passed, and 17 dependencies no source states went into the document. Only rows whose first
 * cell is a requirement field are converted, so other tables are left as they are.
 */
export function fieldRowsAsLabels(md: string): string {
  if (!/^\s*\|\s*(?:requirement statement|source reference|dependenc(?:y|ies))\s*\|/im.test(md)) return md;
  return md.split("\n").map((line) => {
    const m = /^\s*\|\s*\**([^|*]{2,30}?)\**\s*\|\s*(.*?)\s*\|?\s*$/.exec(line);
    if (!m || !FIELD_LABEL.test(m[1].trim()) || /^:?-{2,}/.test(m[2])) return line;
    return `**${m[1].trim()}:** ${m[2]}\n`;
  }).join("\n");
}

// --- 1a. Dependencies must quote a source ------------------------------------------------

export type DependencyIssue = { requirement: string; value: string; reason: "no-quote" | "quote-not-found" };

const NO_DEPENDENCY = /^(?:not specified|none(?: identified)?|n\/a|no information provided|not available in source|no dependenc)/i;
const DEPENDENCY_LINE = /^\s*(?:[-*>]\s+)?\**\s*Dependenc(?:y|ies)\s*\**\s*:\s*\**\s*(.*)$/i;
const REQUIREMENT_ID = /\b([A-Z]{1,4}-\d{1,4})\b/;

/**
 * A requirement's Dependencies field may name a dependency only if a source states it, and
 * must quote the sentence that does. Left to an instruction, about 70% of the links in a live
 * BRD were the document's own inference ("REQ-060 depends on REQ-056 through REQ-059") — it
 * follows the order the document happened to be written in, not anything a source says. A
 * quote is something the server can look for, so "Not specified" becomes the easier answer.
 */
export function dependencyIssues(artifact: string, sourceTexts: string[]): { checked: number; issues: DependencyIssue[] } {
  const hay = ` ${sourceTexts.map(plainKey).join(" ")} `;
  const found = (quote: string) =>
    quote.split(/\s*(?:…|\.\.\.)\s*/).filter((f) => f.trim().split(/\s+/).length >= 4).every((f) => hay.includes(` ${plainKey(f)} `)) &&
    plainKey(quote).split(" ").length >= 4;

  let current = "";
  let checked = 0;
  const issues: DependencyIssue[] = [];
  for (const line of artifact.split("\n")) {
    if (/^#{1,6}\s/.test(line) || ID_LED.test(line)) current = line.match(REQUIREMENT_ID)?.[1] ?? current;
    const m = line.match(DEPENDENCY_LINE);
    if (!m) continue;
    // "*Not specified in source.*" is italic more often than not; the opening marker made it read as a dependency.
    const value = m[1].replace(/^[*_\s]+|[*_\s]+$/g, "").trim();
    if (!value || NO_DEPENDENCY.test(value)) continue;
    checked++;
    const quotes = [...value.matchAll(/[“"]([^”"]{15,500})[”"]/g)].map((q) => q[1]);
    if (!quotes.length) { issues.push({ requirement: current || "(unnamed)", value: value.slice(0, 100), reason: "no-quote" }); continue; }
    if (!quotes.some(found)) issues.push({ requirement: current || "(unnamed)", value: value.slice(0, 100), reason: "quote-not-found" });
  }
  return { checked, issues };
}

export function formatDependencyIssues(r: { checked: number; issues: DependencyIssue[] }, max = 25): string | null {
  if (!r.issues.length) return null;
  const lines = r.issues.slice(0, max).map(
    (i) => `- ${i.requirement}: “${i.value}” — ${i.reason === "no-quote" ? "no source sentence quoted" : "the quoted sentence is not in any source"}`
  );
  return (
    `⚠ **Dependencies not backed by a source — ${r.issues.length} of ${r.checked}:**\n${lines.join("\n")}` +
    (r.issues.length > max ? `\n- …and ${r.issues.length - max} more.` : "") +
    `\nA dependency belongs in the document only where a source states it. Give the sentence that does, in quotation marks ` +
    `(\`Dependencies: REQ-007 — “the quoted source sentence”\`), or write *Not specified*. Do not link requirements because they sit next to each other.`
  );
}

// --- 1a'. The source's strength must be kept ---------------------------------------------------

// "required" alone is usually an adjective ("a required field"); only the modal uses count.
const MANDATORY = /\b(?:shall|must|will|(?:is|are|be|been|being)\s+required|required\s+to|(?:is|are|be)\s+mandatory)\b/i;
const RECOMMENDED = /\b(?:should|ideally|recommended|expected to)\b/i;
const PERMISSIVE = /\b(?:may|might|could|can|potentially|optional(?:ly)?|possibly)\b/i;
const LEVEL_WORD = ["permissive", "recommended", "mandatory"];

/** 0 permissive, 1 recommended, 2 mandatory; the strongest modal present; null if none. */
export function strengthOf(s: string): number | null {
  if (MANDATORY.test(s)) return 2;
  if (RECOMMENDED.test(s)) return 1;
  if (PERMISSIVE.test(s)) return 0;
  return null;
}

const strongestWord = (s: string) => (s.match(MANDATORY) ?? s.match(RECOMMENDED) ?? s.match(PERMISSIVE))?.[0].toLowerCase() ?? "";

/** A source that only suggests: "This suggests corrected invoices can be regenerated" is not a requirement. */
const HEDGE = /\b(?:suggests?|implies|implied|appears? to|seems? to|likely|probably|presumably|may indicate|could indicate|potentially)\b/i;

export type StrengthIssue = {
  citation: string; claim: string; claimWord: string; sourceWord: string; sourceSentence: string;
  /** hardened (default): the claim is stronger than the source; weakened: an obligation became a suggestion. */
  direction?: "weakened";
};

const LIST_ITEM = /^\s*(?:[-*+•]\s+|\d+[.)]\s+)/;
/**
 * A line that ends in a colon governs what follows it: the whole bullet list, or the single line under it. Left
 * apart, "Credit checks should occur during:" kept only its first bullet and a claim naming all three points
 * matched nothing, so "must occur" went unflagged.
 */
function joinLeadIns(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/:\s*$/.test(line) && line.trim().length > 3) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length) {
        if (LIST_ITEM.test(lines[j])) {
          while (j < lines.length) {
            if (LIST_ITEM.test(lines[j])) { line += " " + lines[j].replace(LIST_ITEM, "").trim(); j++; }
            else if (!lines[j].trim() && j + 1 < lines.length && LIST_ITEM.test(lines[j + 1])) j++;
            else break;
          }
        } else if (!/^\s*#/.test(lines[j])) { line += " " + lines[j].trim(); j++; }
        i = j - 1;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

type Sentences = { text: string; bi: Set<string>; words: Set<string> }[];
/** Per call, never kept: the same citation id can name different text on the next save. */
function sentencesOf(cache: Map<string, Sentences>, key: string, text: string): Sentences {
  let s = cache.get(key);
  if (!s) {
    // "Invoice may include:" with its list on the next line is one sentence; apart, the modal and what it governs never met.
    s = joinLeadIns(text).split(/(?<=[.!?])\s+|\n+/).map((t) => t.trim()).filter((t) => t.length > 20 && !t.includes("?"))
      .map((t) => ({ text: t, bi: new Set(bigramList(contentWords(t))), words: new Set(contentWords(t).map(stem)) }));
    cache.set(key, s);
  }
  return s;
}

/**
 * "May" written as "shall". Each claim is matched to the source sentence it reproduces; when
 * that sentence says may or should and the claim says shall or must, the document has settled
 * something the source left open. A claim that carries its own "the source says 'should'; this is
 * preserved" note while saying "shall" is the case this was built for.
 */
export function strengthIssues(artifact: string, sources: Map<string, string>): StrengthIssue[] {
  const out: StrengthIssue[] = [];
  const cache = new Map<string, Sentences>();
  for (const u of citationUnits(artifact)) {
    // A question has no strength, and a metadata line ("Source Reference: …") is not a claim.
    if (u.claim.includes("?") || /^\s*(?:source|sources|priority|dependenc|open question)/i.test(u.claim)) continue;
    // One claim sentence at a time. A statement that says "should maintain credit status" and then, in its own words,
    // "additional statuses may emerge" holds two strengths; comparing its strongest modal with the source sentence
    // for the second was a false finding that a live run spent six rewrites on.
    // Words inside quotation marks are the source's own (the quote check holds them to it), not the document's claim:
    // "…states: “…whether cleaning is required…”" was read as a requirement made mandatory.
    for (const claim of u.claim.replace(/[“"][^”"]{8,}[”"]/g, " ").split(/(?<=[.!?])\s+/)) {
      const claimLevel = strengthOf(claim);
      if (claimLevel === null) continue;
      const claimBi = bigramList(contentWords(claim));
      // Three is enough here: the match below needs every one of them in a single source sentence, and "The invoice shall include LDW charges"
      // (three pairs) was the "may include" list of the task prompt made mandatory.
      // Even two: "The system must support rebilling." is the whole of a requirement whose source says "should support".
      if (claimBi.length < 2) continue;
      const claimStems = contentWords(claim).map(stem);
      for (const c of new Set((u.text.match(CITE) ?? []).map(citationKey))) {
        const text = sources.get(c);
        if (!text) continue;
        let best: { text: string; shared: number; ratio: number } | null = null;
        for (const s of sentencesOf(cache, c, text)) {
          let shared = 0; for (const b of claimBi) if (s.bi.has(b)) shared++;
          const ratio = s.bi.size ? shared / s.bi.size : 0;
          // A short claim inside a long source sentence is the same sentence, though little of the sentence is in the claim.
          const contained = shared / claimBi.length >= 0.7;
          // A lead-in with its list ("Quote may convert to: Reservation Agreement") is a few words long: a claim that merely shares them
          // is not that sentence, so for those the claim must be inside the sentence, not the other way round.
          // A claim of three to five words has too few pairs to prove it is the sentence; all of its words in one
          // source sentence does ("The invoice shall include LDW charges" against a list that "may include" them).
          const short = claimStems.length >= 3 && claimStems.length <= 5 && claimStems.every((w) => s.words.has(w));
          if (((shared >= 3 && ((ratio >= 0.5 && !s.text.includes(": ")) || contained)) || short) && (!best || shared > best.shared || (shared === best.shared && ratio > best.ratio))) best = { text: s.text, shared, ratio };
        }
        if (!best) continue;
        const hedged = HEDGE.test(best.text) && !HEDGE.test(claim);
        // A hedged source sits below "may": any modal the claim adds to it is stronger than the source.
        const srcLevel = hedged ? -1 : strengthOf(best.text);
        const base = { citation: c, claim: claim.replace(/\s+/g, " ").slice(0, 120), claimWord: strongestWord(claim), sourceWord: hedged ? (best.text.match(HEDGE)?.[0].toLowerCase() ?? "suggests") : strongestWord(best.text), sourceSentence: best.text.replace(/\s+/g, " ").slice(0, 140) };
        if (srcLevel !== null && claimLevel > srcLevel) out.push(base);
        else if (srcLevel === 2 && claimLevel < 2) out.push({ ...base, direction: "weakened" });
      }
    }
  }
  return out;
}

export interface DanglingRefs { sections: string[]; ids: string[]; }

/**
 * References inside the document that point at nothing in it: "Section 7" when the document stops at 6, or
 * "OQ-012" when no open question is ever defined. IDs that appear in a source text (`sourceTexts`) are the sources'
 * own and are ignored, as are Golden items (GLD-…), which live outside the document.
 */
export function danglingReferences(doc: string, sourceTexts: string[] = []): DanglingRefs {
  const lines = doc.split(/\r?\n/);
  const headingNums = new Set<string>();
  for (const l of lines) {
    const m = /^#{1,6}\s+(?:Section\s+)?(\d+(?:\.\d+)*)\b/i.exec(l);
    if (m) { let acc = ""; for (const part of m[1].split(".")) { acc = acc ? `${acc}.${part}` : part; headingNums.add(acc); } }
  }
  const sections = new Set<string>();
  if (headingNums.size) {
    for (const m of doc.matchAll(/(?:\bSections?\s+|§\s*)(\d+(?:\.\d+)*)\b/gi)) {
      if (headingNums.has(m[1])) continue;
      // "Detailed-Requirements.md, Section 14" is the source's own numbering, not this document's.
      const before = doc.slice(Math.max(0, (m.index ?? 0) - 120), m.index ?? 0);
      if (/\.(?:md|docx?|pdf|txt)\b|inputs\/|GLD-|\b(?:source|prompt|requirements document|specification)\b|\b[A-Z][\w-]*-[A-Z][\w-]*\b/i.test(before)) continue;
      sections.add(m[1]);
    }
  }

  // An ID inside a longer one is not an ID of its own: "GLD-REF-135" was read as "REF-135", never defined. And a
  // one-letter prefix is still the source's own ID: "Crossroads R-11" from a risk register was reported as dangling.
  const ID = /(?<![A-Za-z0-9]-)\b([A-Z]{1,6})-(\d{1,4})\b/g;
  const fromSources = new Set<string>();
  for (const t of sourceTexts) for (const m of t.matchAll(ID)) fromSources.add(m[0]);
  const defined = new Set<string>();
  const referenced = new Set<string>();
  for (const l of lines) {
    // An ID defines itself when it opens the item and is followed by its title or text, not by a bare aside:
    // "- OQ-012 (to be raised with Finance)" mentions OQ-012 and says nothing about what it is.
    // The \b keeps the ID whole: without it "SC-01 (placeholder)" backtracked to define "SC-0", titled "1 (placeholder)".
    const lead = /^\s*(?:#{1,6}\s+|[-*+]\s+|\|\s*|\d+\.\s+)?(?:\*\*|__)?\s*([A-Z]{1,6}-\d{1,4})\b(?:\*\*|__)?\s*(?:[—–:.|-]\s*)?(?![(\[])(\S.*)?$/.exec(l);
    if (lead && (lead[2] ?? "").trim().length >= 3) defined.add(lead[1]);
    else if (lead && /^\s*(?:#{1,6}\s+|\|)/.test(l)) defined.add(lead[1]); // a bare heading or table cell is a definition
    // A table row whose first cell is the ID, a bracketed note after it ("| SC-01 (placeholder) | …"), defines it too.
    else if (/^\s*\|\s*(?:\*\*|__)?([A-Z]{1,6}-\d{1,4})(?:\*\*|__)?\s*\([^|]*\)\s*\|/.test(l)) defined.add(/([A-Z]{1,6}-\d{1,4})/.exec(l)![1]);
    else {
      // Run 20's writer opened each requirement with a bold ID on a line of its own and an "| Requirement ID | REQ-004 |"
      // row under it; both define the ID, and without them 66 requirements were reported as "never defined".
      const own = /^\s*(?:\*\*|__)([A-Z]{1,6}-\d{1,4})(?:\*\*|__)\s*:?\s*$/.exec(l) ?? /^\s*\|\s*(?:\*\*|__)?(?:[A-Za-z]+\s+)?ID(?:\*\*|__)?\s*\|\s*(?:\*\*|__)?([A-Z]{1,6}-\d{1,4})(?:\*\*|__)?\s*\|/i.exec(l);
      if (own) defined.add(own[1]);
    }
  }
  for (const m of doc.matchAll(ID)) {
    if (m[1] === "GLD" || fromSources.has(m[0])) continue;
    referenced.add(m[0]);
  }
  // Only a prefix the document uses for its own items can be "undefined"; a stray "UTF-8" or "ISO-9001" is not one.
  const definedPrefixes = new Set([...defined].map((d) => d.split("-")[0]));
  const referencedByPrefix = new Map<string, number>();
  for (const r of referenced) referencedByPrefix.set(r.split("-")[0], (referencedByPrefix.get(r.split("-")[0]) ?? 0) + 1);
  const ids = [...referenced].filter((r) => {
    const p = r.split("-")[0];
    if (defined.has(r)) return false;
    return definedPrefixes.has(p) || (referencedByPrefix.get(p) ?? 0) >= 3;
  });
  const byNum = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  return { sections: [...sections].sort(byNum), ids: ids.sort(byNum) };
}

export function formatDanglingReferences(d: DanglingRefs, max = 15): string | null {
  if (!d.sections.length && !d.ids.length) return null;
  const parts: string[] = [];
  if (d.sections.length) parts.push(`sections that do not exist: ${d.sections.slice(0, max).map((s) => `Section ${s}`).join(", ")}`);
  if (d.ids.length) parts.push(`IDs used but never defined: ${d.ids.slice(0, max).join(", ")}${d.ids.length > max ? ` …and ${d.ids.length - max} more` : ""}`);
  return (
    `⚠ **The document points at things it does not contain — ${parts.join("; ")}.**\n` +
    `Either write the missing section or item (use write_section), or remove the pointers to it. A reader who follows these gets nowhere.`
  );
}

export function formatStrengthIssues(issues: StrengthIssue[], max = 20): string | null {
  if (!issues.length) return null;
  const line = (i: StrengthIssue) => `- “${i.claim}” says **${i.claimWord}**; \`${i.citation}\` says **${i.sourceWord}**: “${i.sourceSentence}”`;
  const hardened = issues.filter((i) => i.direction !== "weakened");
  const weakened = issues.filter((i) => i.direction === "weakened");
  const parts: string[] = [];
  if (hardened.length)
    parts.push(
      `⚠ **Source strength changed — ${hardened.length} requirement${hardened.length > 1 ? "s" : ""} say more than their source:**\n${hardened.slice(0, max).map(line).join("\n")}` +
      (hardened.length > max ? `\n- …and ${hardened.length - max} more.` : "") +
      `\nWhere a source says "may", "should" or only "suggests", keep that — or say the strength is undecided. Writing "shall" settles something the source left open.`
    );
  if (weakened.length)
    parts.push(
      `⚠ **Source obligation softened — ${weakened.length} requirement${weakened.length > 1 ? "s" : ""} say less than their source:**\n${weakened.slice(0, max).map(line).join("\n")}` +
      (weakened.length > max ? `\n- …and ${weakened.length - max} more.` : "") +
      `\nWhere a source says "must" or "shall", the requirement keeps it. Turning an obligation into "should" or "may" drops it without anyone deciding to.`
    );
  return parts.join("\n\n");
}

/**
 * A document that cites nothing the server can check is not a document that passed —
 * the check never ran. (A live run cited its sources as "DR §" and "PF §" after defining
 * the abbreviations in a header; every citation was invisible to the check, and it said
 * nothing.) Short documents are left alone.
 */
export function noCheckableCitations(r: CitationReport, documentChars: number): string | null {
  if (r.checked > 0 || documentChars < 1500) return null;
  return (
    `⚠ **Citation check could not run:** no statement in this document cites a source in a form the server can check ` +
    `(\`inputs/<file>.md\` or \`GLD-XXX-nnn@v\`)${r.unverifiable ? `; ${r.unverifiable} cited source(s) could not be read` : ""}. ` +
    `Abbreviations such as "DR" or "PF" are not recognised. Cite each requirement with the full file name of its source, then save again.`
  );
}

// --- 1b. Roles no source names ---------------------------------------------------------

const ROLE_WORD =
  "Team|Teams|Manager|Managers|Leadership|Owner|Owners|User|Users|Administrator|Administrators|Representative|Representatives|" +
  "Officer|Lead|Director|Analyst|Approver|Approvers|Staff|Department|Executive|Executives|Dispatcher|Controller|Clerk|" +
  "Technician|Supervisor|Coordinator|Specialist|Planner|Operator";
// The lookahead drops a role word that is really the start of another noun ("User Experience").
const ROLE = new RegExp(
  `\\b((?:[A-Z][A-Za-z]+(?:\\s*[/&]\\s*|\\s+and\\s+|\\s+)){1,3}(?:${ROLE_WORD}))\\b(?!\\s+(?:Experience|Interface|Interfaces|Stor|Account|Group|Profile|Journey|Guide|Role|Roles|Type|Types))`,
  "g"
);
const LEADING_NOISE = new Set(["the", "a", "an", "this", "that", "each", "every", "all", "any", "our", "their", "its", "both", "for", "as", "by", "with", "when", "if", "where", "who", "and", "or", "to", "of", "in", "on", "per"]);
const plainKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Role-like names the document uses that no source contains. The failure was seen in every
 * run that wrote about stakeholders or audiences: "Finance user", "Billing Administrator",
 * "Executive Leadership" — plausible, written as if the documents named them, and absent
 * from all of them. A name that appears nowhere in the sources is not a finding from them.
 *
 * Phrase presence only, so a role the source names in other words is flagged too; the
 * report says what it compared. Single-word roles are ignored — too many are ordinary words.
 */
export function inventedRoles(artifact: string, sourceTexts: string[]): string[] {
  const haystack = ` ${sourceTexts.map(plainKey).join(" ")} `;
  const found = new Map<string, string>();
  for (const m of artifact.matchAll(ROLE)) {
    const words = m[1].split(/\s+/);
    while (words.length && LEADING_NOISE.has(words[0].toLowerCase())) words.shift();
    if (words.length < 2) continue;
    const phrase = words.join(" ").replace(/\s*([/&])\s*/g, " $1 ");
    const key = plainKey(phrase);
    if (!key || found.has(key)) continue;
    const variants = [key, key.endsWith("s") ? key.slice(0, -1) : `${key}s`];
    if (variants.some((v) => haystack.includes(` ${v} `))) continue;
    found.set(key, phrase.replace(/ ([/&]) /g, " $1 "));
  }
  return [...found.values()].slice(0, 12);
}

export function formatInventedRoles(roles: string[]): string | null {
  if (!roles.length) return null;
  return (
    `⚠ **Roles that appear in none of the sources:** ${roles.map((r) => `“${r}”`).join(", ")}. ` +
    `If the sources do not name stakeholders, audiences or actors, write *Not specified in source* and raise it as an open question ` +
    `rather than supplying plausible roles. (This compares the exact phrase with the sources, so a role a source names in other words is also listed.)`
  );
}

// --- 2. Terms defined differently by different sources -----------------------------

export type Definition = { term: string; text: string; source: string; formula?: boolean };

const NOT_A_TERM = new Set([
  "note", "notes", "example", "examples", "purpose", "source", "sources", "status", "priority", "scope", "objective",
  "process", "trigger", "actors", "inputs", "outputs", "lifecycle", "important", "warning", "summary", "description",
  "requirement", "requirements", "rule", "rules", "none", "yes", "no", "version", "date", "title", "name", "type",
  // A pronoun or determiner opening a sentence is not a term being defined.
  "this", "that", "these", "those", "it", "there", "which", "what", "here", "each", "all", "both", "some", "such",
]);

const normTerm = (t: string) => {
  const s = t.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
  return s.length > 4 && s.endsWith("s") && !s.endsWith("ss") ? s.slice(0, -1) : s;
};

/** Join wrapped continuation lines (a list item broken across lines) so a definition is one string. */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    if (out.length && /^\s{2,}\S/.test(raw) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(raw) && out[out.length - 1].trim()) out[out.length - 1] += " " + raw.trim();
    else out.push(raw);
  }
  return out;
}

export function extractDefinitions(text: string, source: string): Definition[] {
  const defs: Definition[] = [];
  const add = (term: string, def: string, formula = false) => {
    // "Total Exposure" and "Exposure" are the same term.
    const t = term.replace(/^(?:the|a|an)\s+/i, "").replace(/^(?:total|net|gross)\s+/i, "").trim();
    const d = def.replace(/\s+/g, " ").trim();
    if (!t || t.split(/\s+/).length > 4 || NOT_A_TERM.has(t.toLowerCase())) return;
    if (d.split(/\s+/).length < 3 || d.length > 320) return;
    // "draft → priced → sent → accepted" is a lifecycle, not a definition. A live run recorded
    // one as a "conflict" with a purpose statement and had to be told it was fabricated.
    if (/→|->|=>/.test(d)) return;
    defs.push({ term: t, text: d, source, ...(formula ? { formula: true } : {}) });
  };
  const ls = logicalLines(text);
  for (let i = 0; i < ls.length; i++) {
    const line = plain(ls[i]);
    if (!line) continue;
    // | Term | Definition |   — skip a header row (the next line is a separator)
    const row = line.match(/^\|\s*([^|]{2,40}?)\s*\|\s*([^|]{15,320}?)\s*\|/);
    if (row && !/^\s*\|?\s*:?-{2,}/.test(ls[i + 1] ?? "")) { add(row[1], row[2]); continue; }
    // Term = a + b + c   — a formula; two sources can name different components for one term
    const eq = line.match(/^([A-Z][A-Za-z ]{1,30}?)\s*=\s*(\S.*\+.*)$/);
    if (eq) { add(eq[1], eq[2], true); continue; }
    // Term: definition   /   Term — definition
    const label = line.match(/^([A-Z][A-Za-z0-9/&' -]{1,38}?)\s*[:—–]\s+(\S.{15,320})$/);
    if (label) { add(label[1], label[2]); continue; }
    // Term represents / means / is the ... .
    const sent = line.match(/^(?:(?:The|A|An)\s+)?([A-Z][A-Za-z/&-]*(?: [A-Z][A-Za-z/&-]*){0,2}) (?:represents|means|refers to|is defined as|is the|is a|is an) (.{10,300}?)(?:[.!?]|$)/);
    if (sent) add(sent[1], sent[2]);
  }
  return defs;
}

const defWords = (s: string) => new Set(contentWords(s).map(stem));
function similarity(a: string, b: string): number {
  const x = defWords(a), y = defWords(b);
  if (!x.size || !y.size) return 1;
  let both = 0; for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

export type TermConflict = { term: string; versions: { source: string; text: string }[] };

/**
 * A term two different sources define in unlike words. Candidates for a person to judge, not verdicts.
 *
 * `anchor` keeps only conflicts that involve at least one source it accepts — the task and
 * the project's own documents. Without it, a BRD project with 23 reference documents attached
 * reported eight "conflicts" between engineering standards that have nothing to do with the
 * document being written, and the agent wrote them all into it.
 */
export function termConflicts(
  sources: { name: string; text: string }[], threshold = 0.4, anchor?: (sourceName: string) => boolean
): TermConflict[] {
  const byTerm = new Map<string, { term: string; defs: Definition[] }>();
  for (const s of sources)
    for (const d of extractDefinitions(s.text, s.name)) {
      const k = normTerm(d.term);
      if (!byTerm.has(k)) byTerm.set(k, { term: d.term, defs: [] });
      byTerm.get(k)!.defs.push(d);
    }
  const out: TermConflict[] = [];
  for (const { term, defs } of byTerm.values()) {
    const bySource = new Map<string, Definition>();
    for (const d of defs) if (!bySource.has(d.source)) bySource.set(d.source, d);
    const list = [...bySource.values()];
    if (list.length < 2) continue;
    let min = 1;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) min = Math.min(min, similarity(list[i].text, list[j].text));
    // Formulas share most of their words even when a component differs ("Current Transaction
    // Value" vs "New Order Value"), so they are held to a stricter similarity.
    const limit = list.some((d) => d.formula) ? Math.max(threshold, 0.6) : threshold;
    if (min < limit && (!anchor || list.some((d) => anchor(d.source))))
      out.push({ term, versions: list.map((d) => ({ source: d.source, text: d.text })) });
  }
  return out.sort((a, b) => b.versions.length - a.versions.length || a.term.localeCompare(b.term)).slice(0, 15);
}

export function formatConflicts(c: TermConflict[]): string {
  if (!c.length) return "No term was found defined in unlike words by two different sources. This is a pattern match over definition-shaped sentences, so it can miss conflicts phrased any other way.";
  return (
    `${c.length} term${c.length > 1 ? "s are" : " is"} defined in unlike words by different sources:\n\n` +
    c.map((x) => `**${x.term}**\n` + x.versions.map((v) => `- ${v.source}: “${v.text}”`).join("\n")).join("\n\n") +
    `\n\nFor each one that is a genuine disagreement, write **Source Conflict Identified** in the document, quote both wordings with their sources, and do not choose between them. ` +
    `If two wordings are the same thing said differently, say that instead. This only finds definitions written as "Term: ...", "Term represents ...", or glossary rows — conflicts in other forms, and different names for the same thing, still need your own reading.`
  );
}

/** Conflict terms the artifact never mentions — the check applied at save time. */
export function unaddressedConflicts(artifact: string, conflicts: TermConflict[]): string[] {
  const lower = artifact.toLowerCase();
  const flagged = /source conflict/i.test(artifact);
  return conflicts.filter((c) => !flagged || !lower.includes(c.term.toLowerCase())).map((c) => c.term);
}

// --- 3. Template structure ----------------------------------------------------------

const headingKey = (h: string) => h.toLowerCase().replace(/^\s*\d+(?:\.\d+)*\.?\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
const h2 = (md: string) => md.split("\n").filter((l) => /^##\s+\S/.test(l) && !/^###/.test(l)).map((l) => l.replace(/^##\s+/, "").trim());

export type StructureDeviation = { missing: string[]; extra: string[]; outOfOrder: boolean };

/** Sections the template names that the artifact lacks, plus anything it adds. Null when the template defines none. */
export function templateDeviations(template: string, artifact: string): StructureDeviation | null {
  const want = h2(template);
  if (!want.length) return null;
  const have = h2(artifact);
  const wantKeys = want.map(headingKey), haveKeys = have.map(headingKey);
  const found = (k: string) => haveKeys.findIndex((h) => h === k || h.includes(k) || k.includes(h));
  const missing = want.filter((_, i) => found(wantKeys[i]) < 0);
  const extra = have.filter((_, i) => !wantKeys.some((k) => haveKeys[i] === k || haveKeys[i].includes(k) || k.includes(haveKeys[i])));
  const positions = wantKeys.map(found).filter((p) => p >= 0);
  const outOfOrder = positions.some((p, i) => i > 0 && p < positions[i - 1]);
  return { missing, extra, outOfOrder };
}

export function formatDeviation(d: StructureDeviation, templateLabel: string): string | null {
  if (!d.missing.length && !d.extra.length && !d.outOfOrder) return null;
  const parts: string[] = [];
  if (d.missing.length) parts.push(`missing: ${d.missing.map((m) => `“${m}”`).join(", ")}`);
  if (d.extra.length) parts.push(`not in the template: ${d.extra.slice(0, 8).map((m) => `“${m}”`).join(", ")}${d.extra.length > 8 ? ", …" : ""}`);
  if (d.outOfOrder) parts.push("the sections are in a different order");
  return `⚠ **Structure check against ${templateLabel}:** ${parts.join("; ")}. Match the template's sections, then save again.`;
}

// --- 4. Constructs the task forbids ---------------------------------------------------

const CONSTRUCTS: Record<string, { task: RegExp; used: (md: string) => { count: number; example: string } }> = {
  "user stories": {
    task: /\buser stor(?:y|ies)\b/gi,
    used: (md) => {
      const m = md.match(/\bAs an? [^\n,]{2,80}?, I (?:want|need|can|would like|am able)[^\n]{0,60}/gi) ?? [];
      return { count: m.length, example: m[0] ?? "" };
    },
  },
  "acceptance criteria": {
    task: /\bacceptance criteria\b/gi,
    used: (md) => {
      const given = md.match(/^[\s>*_\-\d.]*\**Given\b[^\n]{0,80}/gim) ?? [];
      const head = md.match(/^#{1,6}\s*(?:\d+(?:\.\d+)*\.?\s*)?Acceptance Criteria\b[^\n]*/gim) ?? [];
      return { count: given.length + head.length, example: (head[0] ?? given[0] ?? "").trim() };
    },
  },
};

const PROHIBITION = /\b(?:do not|don'?t|must not|should not|shall not|never|not\s+(?:generate|describe|include|be|add|write|create|produce)|prohibit\w*|forbidden|exclude\w*)\b/i;
const REQUEST = /\b(?:write|include|generate|produce|provide)\b/i;

/**
 * Constructs the task prohibits. A construct counts only when every mention of it sits
 * under a prohibition cue and none is asked for — so "write user stories" and "do not
 * write user stories" are told apart, and an ambiguous task prohibits nothing.
 */
export function constructsProhibitedBy(task: string): string[] {
  const prohibited: string[] = [];
  for (const [name, c] of Object.entries(CONSTRUCTS)) {
    const mentions = [...task.matchAll(c.task)];
    if (!mentions.length) continue;
    const allUnderCue = mentions.every((m) => {
      const start = m.index ?? 0;
      const lineStart = task.lastIndexOf("\n", start) + 1;
      const lineEnd = task.indexOf("\n", start); const line = task.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
      if (REQUEST.test(line) && !PROHIBITION.test(line)) return false;
      return PROHIBITION.test(task.slice(Math.max(0, start - 600), start + m[0].length));
    });
    if (allUnderCue) prohibited.push(name);
  }
  return prohibited;
}

export function prohibitedUsed(artifact: string, constructs: string[]): { construct: string; count: number; example: string }[] {
  return constructs
    .map((c) => ({ construct: c, ...CONSTRUCTS[c].used(artifact) }))
    .filter((r) => r.count > 0);
}

export function formatProhibited(r: { construct: string; count: number; example: string }[]): string | null {
  if (!r.length) return null;
  return (
    `⚠ **The task prohibits constructs this document contains:**\n` +
    r.map((x) => `- ${x.construct}: ${x.count} found, e.g. “${x.example.replace(/\s+/g, " ").slice(0, 110)}”`).join("\n") +
    `\nRemove them — the task's prohibitions override your default document structure — then save again.`
  );
}

// --- Omissions: what the sources say that the document does not --------------------------------
//
// The checks above test what the document claims. None of them can see what it leaves out, and a
// live run showed that: a BRD with no invented roles, no dangling references and every citation
// resolving had also dropped a scope item, every source-stated dependency and the UX section.

/** The prefix a document uses for its requirements — REQ, FR, BR … — or the one it defines most. */
const REQUIREMENT_PREFIX = /^(?:REQ|FR|NFR|BR|RQ|R)$/;
const DEFINES_ID = /^(\s*)(#{1,6}\s+|[-*+]\s+|\|\s*|\d+\.\s+)?(?:\*\*|__)?\s*([A-Z]{1,6})-(\d{1,4})\b/;

/** The text of the document's requirement items only — not its open questions, stakeholders or glossary. */
export function requirementText(doc: string): string {
  return requirementBlocks(doc).join("\n");
}

/** One entry per requirement item: its heading or row and the lines under it. */
/**
 * Requirements that state the same thing: each area is written by its own writer, and nothing else stops two of
 * them taking the same source item. Two statements are the same when, ignoring case and punctuation, one contains
 * the other, or they differ only in words that carry no meaning ("the", "and"…). Short statements (under 8 words) are ignored: "Charges may be
 * applied." recurs legitimately.
 */
export function duplicateRequirements(doc: string): { ids: string[]; statement: string }[] {
  const items = requirementBlocks(doc).map((b) => {
    const id = /\b[A-Z]{1,6}-\d{1,4}\b/.exec(b)?.[0] ?? "";
    const s = /\*\*Requirement Statement:\*\*\s*([\s\S]*?)(?=\n\s*\n|\n\s*\*\*[A-Z]|$)/.exec(b)?.[1] ?? "";
    const n = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return { id, s: s.trim(), n, w: new Set(n.split(" ").filter(Boolean)) };
  }).filter((x) => x.id && x.w.size >= 8);
  const out: { ids: string[]; statement: string }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    if (seen.has(items[i].id)) continue;
    const group = [items[i].id];
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      // Near-identical only. Per-item requirements ("Weekly Billing …" / "28-Day Billing …", "Invoice Forms …" /
      // "Quote Forms …") differ by the one word that matters, and a word-overlap threshold flagged them in every run.
      const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "is", "are", "be", "this", "that", "with", "as", "by", "it", "its", "also"]);
      const diff = [...a.w].filter((x) => !b.w.has(x)).concat([...b.w].filter((x) => !a.w.has(x))).filter((x) => !STOP.has(x));
      if (a.n.includes(b.n) || b.n.includes(a.n) || diff.length === 0) { group.push(b.id); seen.add(b.id); }
    }
    if (group.length > 1) out.push({ ids: group, statement: items[i].s.replace(/\s+/g, " ").slice(0, 140) });
  }
  return out;
}

export function formatDuplicateRequirements(d: { ids: string[]; statement: string }[], max = 10): string | null {
  if (!d.length) return null;
  return (
    `⚠ **Requirements that say the same thing — ${d.length}:**\n` +
    d.slice(0, max).map((x) => `- ${x.ids.join(", ")}: “${x.statement}”`).join("\n") +
    (d.length > max ? `\n- …and ${d.length - max} more.` : "") +
    `\nKeep one of each (the one in the area its source section belongs to) and delete the others with patch_section, or make each state what is distinct about it.`
  );
}

/** Prefixes of requirement-like items a BRD defines: functional, non-functional, technical, integration, data, business rules. */
const REVIEWABLE_PREFIX = /^(?:REQ|RQ|FR|NFR|TR|TECH|IR|INT|DR|DATA|BR|R)$/;

/**
 * Every requirement-like item of the document, whatever its prefix, for the independent reviewer. requirementBlocks keeps
 * to the one prefix a document uses most: on a BRD with REQ-001…016 and NFR-01…26 it was the NFR rows alone, so the
 * reviewer never read the REQ, TECH or INT items written outside the drafted areas.
 */
export function reviewableBlocks(doc: string): string[] {
  const lines = doc.split("\n");
  const starts = new Map<number, string>();
  const count = new Map<string, number>();
  lines.forEach((l, i) => {
    const m = DEFINES_ID.exec(l);
    if (m) { starts.set(i, m[3]); count.set(m[3], (count.get(m[3]) ?? 0) + 1); }
  });
  const prefixes = new Set([...count.entries()].filter(([p, n]) => REVIEWABLE_PREFIX.test(p) && n >= 3).map(([p]) => p));
  if (!prefixes.size) return requirementBlocks(doc);
  const blocks: string[][] = [];
  const seen = new Set<string>();
  let on = false;
  lines.forEach((l, i) => {
    if (starts.has(i)) {
      const id = `${starts.get(i)}-${DEFINES_ID.exec(l)![4]}`;
      // An ID listed again later (a traceability table, a summary) is a mention, not a second item to review.
      on = prefixes.has(starts.get(i)!) && !seen.has(id);
      if (on) { seen.add(id); blocks.push([]); }
    } else if (/^#{1,6}\s/.test(l)) on = false;
    if (on) blocks[blocks.length - 1].push(l);
  });
  return blocks.map((b) => b.join("\n"));
}

export function requirementBlocks(doc: string): string[] {
  const lines = doc.split("\n");
  const starts = new Map<number, string>();
  const count = new Map<string, number>();
  lines.forEach((l, i) => {
    const m = DEFINES_ID.exec(l);
    if (m) { starts.set(i, m[3]); count.set(m[3], (count.get(m[3]) ?? 0) + 1); }
  });
  let prefix = [...count.entries()].filter(([p, n]) => REQUIREMENT_PREFIX.test(p) && n >= 5).sort((a, b) => b[1] - a[1])[0]?.[0];
  prefix ??= [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!prefix) return [doc];
  const blocks: string[][] = [];
  let on = false;
  lines.forEach((l, i) => {
    if (starts.has(i)) { on = starts.get(i) === prefix; if (on) blocks.push([]); }
    else if (/^#{1,6}\s/.test(l)) on = false;
    if (on) blocks[blocks.length - 1].push(l);
  });
  return blocks.map((b) => b.join("\n"));
}

/** Lines of an approved-scope list in a source or prompt: from "…approved scope" to "anything outside this list". */
export function scopeLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!(l.length < 80 && !/[.:]$/.test(l) && /\b(?:approved|in)[- ]scope\b|\bscope list\b/i.test(l))) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 80); j++) {
      const s = lines[j].trim();
      if (/\bout of scope\b|anything outside|outside (?:of )?(?:this|the) (?:list|scope)/i.test(s)) break;
      if (s) out.push(s.replace(/^[-*•\d.)\s]+/, ""));
    }
    break;
  }
  return out;
}

export type CoverageGap = { scope: string; missing: string };

/**
 * Scope-list items no requirement mentions. A scope line often reaches us as one run of
 * capitalised items with nothing between them ("Multi Equipment Rentals Multi Configuration
 * Rentals"), so items cannot be split. Instead the line's adjacent word pairs are looked up in the
 * requirement text, and two or more missing in a row mark an item that is not there; a single
 * missing pair is usually just the join between two items.
 */
export function coverageGaps(doc: string, sourceTexts: string[]): { scopeLines: number; gaps: CoverageGap[] } {
  const lines = [...new Set(sourceTexts.flatMap(scopeLines))];
  if (!lines.length) return { scopeLines: 0, gaps: [] };
  // A category of the scope ("Credit Management & Collections") is covered by a section headed with it, whose
  // requirements are about its parts ("Credit Limit Allocation"); run 27 was told it was missing.
  // Only a heading whose own section holds requirements counts: a Key Features heading naming the item does not.
  const all = doc.split(/\r?\n/);
  const isHead = (l: string) => /^#{1,6}\s/.test(l), isReq = (l: string) => /^#{1,6}\s+(?:\*\*)?[A-Z]{1,6}-\d/.test(l);
  const headings: string[] = [];
  all.forEach((l, i) => {
    if (!isHead(l) || isReq(l)) return;
    for (let k = i + 1; k < all.length; k++) {
      if (isReq(all[k])) { headings.push(l); return; }
      if (isHead(all[k])) return;
    }
  });
  const blocks = [...requirementBlocks(doc), ...headings];
  const have = bigramSet(blocks.join("\n"));
  const blockWords = blocks.map((b) => new Set(words(b).map(stem)));
  // An item is covered if one requirement mentions all of its words, even in another order.
  const together = (ws: string[]) => blockWords.some((s) => ws.every((w) => s.has(stem(w))));
  const gaps: CoverageGap[] = [];
  let checked = 0;
  for (const line of lines) {
    const cw = contentWords(line);
    if (cw.length < 3) continue; // a heading, not a list of items
    checked++;
    const bg = bigramList(cw);
    let run = 0;
    const flush = (end: number) => {
      if (run >= 2) {
        const phrase = cw.slice(end - run, end + 1);
        if (!together(phrase)) gaps.push({ scope: line.slice(0, 120), missing: phrase.join(" ") });
      }
      run = 0;
    };
    bg.forEach((b, i) => { if (have.has(b)) flush(i); else run++; });
    flush(bg.length);
  }
  return { scopeLines: checked, gaps };
}

export function formatCoverageGaps(g: { scopeLines: number; gaps: CoverageGap[] }, max = 12, documentChars = 0): string | null {
  // Finding no scope list is not a pass: say so rather than let silence read as "covered".
  if (!g.scopeLines && documentChars >= 20000)
    return `ℹ **Scope coverage was not checked** — no approved-scope list was found in the task or the sources, so nothing was compared with your requirements. Check by hand that every item the task names has a requirement.`;
  if (!g.gaps.length) return null;
  const lines = g.gaps.slice(0, max).map((x) => `- “${x.missing}” (scope line: ${x.scope})`);
  return (
    `⚠ **Scope not covered — the approved scope names items that no requirement mentions:**\n${lines.join("\n")}` +
    (g.gaps.length > max ? `\n- …and ${g.gaps.length - max} more.` : "") +
    `\nEvery item in the approved scope needs at least one requirement of its own. Merging fields into one requirement is fine; dropping an item is not. ` +
    `Write the missing requirements with write_section, or tell the user the item has no source detail.`
  );
}

export type OmittedDependency = { sentence: string };

// The noun with what it relates to: "depends on" turns up in every descriptive sentence, "a dependency on X" is a statement
// of one. The noun alone is a topic: "Dependency handling for hidden fields." (a list of discovery areas) was reported as an
// omitted dependency in three runs running.
const DEPENDS = /\bdependenc(?:y|ies)\s+(?:on|upon|between|with)\b/i;
/**
 * Where a labelled field of a requirement ends: at the next labelled field — after a blank line or not, plain or bold, or as
 * a bullet ("- **Open Questions:** …") — at a rule, or at the end of the block. Ending only at a blank line let a field
 * written on consecutive lines swallow the next one.
 */
const FIELD_END = String.raw`(?=\n\s*(?:[-*]\s+)?(?:\*\*)?[A-Z][A-Za-z ]{2,40}(?:\*\*)?\s*:|\n\s*-{3,}|$)`;
export const fieldValue = (block: string, label: string): string | null =>
  new RegExp(String.raw`(?:\*\*)?${label}(?:\*\*)?\s*:(?:\*\*)?([\s\S]*?)${FIELD_END}`, "i").exec(block)?.[1] ?? null;
const INSTRUCTION = /\b(?:do not|don't|must not|never|only (?:if|where|when|include)|avoid|ensure that|ensure the|should be stated|explain |identify dependencies|preserving)\b/i;

/** Source sentences that state a dependency which appears nowhere in the document. */
export function omittedDependencies(doc: string, sourceTexts: string[]): OmittedDependency[] {
  // Carried means held by a requirement's Dependencies field: a sentence quoted only in an appendix, or only under
  // Open Questions (graders marked "Not Specified" beside a quoted "This creates dependency on …" as a miss), does not count.
  // A field that opens "Not Specified" carries nothing, whatever it quotes after: a live run wrote "Not Specified.
  // (Recorded as a risk, not as a dependency: … “This creates dependency on …”)".
  const carried = (b: string) => { const v = (fieldValue(b, "Dependencies") ?? "").trim(); return /^[*_\s]*not specified/i.test(v) ? "" : v; };
  const have = bigramSet(requirementBlocks(doc).map(carried).join("\n"));
  const out: OmittedDependency[] = [];
  const seen = new Set<string>();
  for (const t of sourceTexts) {
    for (const s of t.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim())) {
      if (s.length < 25 || s.length > 400 || s.includes("?") || !DEPENDS.test(s) || INSTRUCTION.test(s)) continue;
      // A run of Capitalised Words is a template's field list ("… Inputs Outputs Dependencies Upstream Impact …"), not a statement.
      const toks = s.split(/\s+/);
      if (toks.filter((t) => /^[A-Z]/.test(t)).length / toks.length > 0.5) continue;
      const bg = bigramList(contentWords(s));
      if (bg.length < 3) continue;
      const key = plainKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      const contained = bg.filter((b) => have.has(b)).length / bg.length;
      if (contained < 0.6) out.push({ sentence: s.replace(/\s+/g, " ") });
    }
  }
  return out;
}

export function formatOmittedDependencies(o: OmittedDependency[], max = 10): string | null {
  if (!o.length) return null;
  return (
    `⚠ **Dependencies the sources state that the document does not carry — ${o.length}:**\n` +
    o.slice(0, max).map((x) => `- “${x.sentence.slice(0, 200)}”`).join("\n") +
    (o.length > max ? `\n- …and ${o.length - max} more.` : "") +
    `\nPut each in the Dependencies field of the requirement it concerns, quoting the sentence: \`<what it depends on> — “the quoted sentence”\`, or \`Dependency to confirm: <what> — “the quoted sentence”\` where the source states it only tentatively or as a risk. Quoting it under Open Questions alone does not carry it. Leaving "Not specified" is right only where no source says so. ` +
    `(This list covers sentences that use the word "dependency"; a source that says "requires X first" or "relies on" is not found, so read the sources for those too.)`
  );
}

// --- Quotes must be verbatim --------------------------------------------------------------

export type QuoteIssue = { quote: string; kind: "reworded" | "not-in-any-source" | "joined" };

/**
 * A source split into the units a quotation may sit inside: a paragraph, one list item, one heading, one table
 * row. Lines that merely continue a paragraph (hard-wrapped prose) stay with it, so wrapping is not a boundary.
 */
export function sourceBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cur = "";
  const flush = () => { if (cur.trim()) blocks.push(cur); cur = ""; };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { flush(); continue; }
    if (/^\s*(?:[-*+•]\s|\d+[.)]\s|#{1,6}\s|\|)/.test(line)) flush();
    cur += (cur ? " " : "") + line;
  }
  flush();
  return blocks;
}

/**
 * Text inside quotation marks is a promise that a source says exactly this. A live document put a
 * bullet list from a source inside one pair of quotes as if it were one sentence, and altered
 * spelling inside quote marks; both read as verbatim and are not. Fragments split on "…" are
 * checked one by one.
 */
export function quoteIssues(doc: string, sourceTexts: string[]): { checked: number; issues: QuoteIssue[] } {
  // "|" survives in no quote key, so a match cannot run across it. Only hard boundaries get one: a heading, a table
  // row, the end of a file. A lead-in line with its bullets, or consecutive bullets, read as one passage in order
  // (measured on live runs: half of all quotes) and are not a defect; `whole` is the boundary-blind view.
  const hard = (b: string) => /^\s*(?:#{1,6}\s|\|)/.test(b);
  const hay = ` ${sourceTexts.map((t) => {
    let out = ""; let prev = "";
    for (const b of sourceBlocks(t)) { out += (out ? (hard(b) || hard(prev) ? " | " : " ") : "") + plainKey(b); prev = b; }
    return out;
  }).join(" | ")} `;
  const whole = ` ${sourceTexts.map(plainKey).join(" ")} `;
  const hayBi = bigramSet(sourceTexts.join("\n"));
  let checked = 0;
  const issues: QuoteIssue[] = [];
  const seen = new Set<string>();
  for (const m of doc.matchAll(/[“"]([^”"\n]{25,600})[”"]/g)) {
    const frags = m[1].split(/\s*(?:…|\.\.\.)\s*/).map((f) => f.trim()).filter((f) => f.split(/\s+/).length >= 5);
    for (const f of frags) {
      const key = plainKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      checked++;
      if (hay.includes(` ${key} `)) continue;
      if (whole.includes(` ${key} `)) { issues.push({ quote: f.replace(/\s+/g, " ").slice(0, 140), kind: "joined" }); continue; }
      const bg = bigramList(contentWords(f));
      const score = bg.length ? bg.filter((b) => hayBi.has(b)).length / bg.length : 0;
      issues.push({ quote: f.replace(/\s+/g, " ").slice(0, 140), kind: score >= 0.6 ? "reworded" : "not-in-any-source" });
    }
  }
  return { checked, issues };
}

export function formatQuoteIssues(r: { checked: number; issues: QuoteIssue[] }, max = 15): string | null {
  if (!r.issues.length) return null;
  const lines = r.issues.slice(0, max).map(
    (i) => `- “${i.quote}” — ${i.kind === "reworded" ? "close to a source, but not the source's words" : i.kind === "joined" ? "runs across a heading, table row or document boundary of the source" : "no source contains this"}`
  );
  return (
    `⚠ **Quotation marks around text that is not verbatim — ${r.issues.length} of ${r.checked} quoted passages:**\n${lines.join("\n")}` +
    (r.issues.length > max ? `\n- …and ${r.issues.length - max} more.` : "") +
    `\nInside quotation marks, copy one passage of the source exactly, not across a heading or table row (use “…” to skip words). To summarise a list or paraphrase, drop the quotation marks and cite the source.`
  );
}

// --- Fields with no value in any source ---------------------------------------------------------

const GROUNDED_FIELDS = /^(?:engagement level|operational frequency|usage frequency|frequency|interaction level|stakeholder type|influence|impact level)$/i;
const NO_VALUE = /^(?:not specified|n\/a|none|tbd|not stated|no information|not available|not defined|to be confirmed)/i;
const FIELD_LINE = /^\s*(?:[-*]\s+)?\*\*([^*:]+):?\*\*:?\s*(.+)$/;

/** Words in an entity's heading that say what kind of thing it is, not which one — they would ground any value. */
const GENERIC_ENTITY = new Set(["stakeholder", "stakeholders", "function", "functions", "team", "teams", "users", "user", "manage", "management", "owner", "owners", "who", "group", "groups", "role", "roles", "audience", "persona"]);

export type UngroundedField ={ entity: string; field: string; value: string };

/**
 * A field such as Engagement Level or Operational Frequency must hold a value some source gives for
 * that entity, or say it is not specified. The value counts as given when one sentence of a source
 * mentions both the value and a word from the entity's heading. All seven engagement levels in a
 * live BRD were invented, and "no roles are named" sat above each of them.
 */
export function ungroundedFields(doc: string, sourceTexts: string[]): UngroundedField[] {
  const sentences = sourceTexts.flatMap((t) => t.split(/(?<=[.!?])\s+|\n+/)).map((s) => new Set(words(s).map(stem)));
  const out: UngroundedField[] = [];
  let entity = "";
  let entityWords: string[] = [];
  for (const line of doc.split("\n")) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      entity = h[1].replace(/^[A-Z]{1,6}-\d{1,4}\s*[—–:.-]*\s*/, "").trim();
      entityWords = contentWords(entity).filter((w) => w.length >= 4 && !GENERIC_ENTITY.has(w)).map(stem);
      continue;
    }
    const m = FIELD_LINE.exec(line);
    if (!m || !GROUNDED_FIELDS.test(m[1].trim())) continue;
    // "*Not specified in source*" is the answer this check asks for; a leading italic marker hid it from NO_VALUE.
    const value = m[2].replace(/^[*_\s]+|[*_.\s]+$/g, "").trim();
    if (!value || NO_VALUE.test(value) || !entityWords.length) continue;
    const terms = value.split(/\s*[,;/]\s*|\s+and\s+/i).map((t) => contentWords(t).map(stem)).filter((t) => t.length);
    const ungrounded = terms.filter((t) => !sentences.some((s) => t.every((w) => s.has(w)) && entityWords.some((e) => s.has(e))));
    if (ungrounded.length) out.push({ entity, field: m[1].trim(), value: value.slice(0, 80) });
  }
  return out;
}

export function formatUngroundedFields(u: UngroundedField[], max = 15): string | null {
  if (!u.length) return null;
  return (
    `⚠ **Field values no source gives — ${u.length}:**\n` +
    u.slice(0, max).map((x) => `- ${x.entity} — ${x.field}: ${x.value}`).join("\n") +
    (u.length > max ? `\n- …and ${u.length - max} more.` : "") +
    `\nWrite *Not specified in source* for any field the sources give no value for. A plausible value is still an invented one.`
  );
}

// --- Sentences of a cited source item left out ---------------------------------------------

export type OmittedItemSentence = { reqs: string[]; item: string; sentence: string };

/** The source's own speculation ("This suggests…"): leaving it out is right, carrying it would read as a requirement. */
const SOURCE_INFERENCE = /^\s*(?:this|which|that)\s+(?:suggests?|implies|indicates?|may\s+(?:suggest|imply|indicate))\b/i;
/** The source describing its own text ("The requirement explicitly states:"): the lead-in is commentary, what follows is the content. */
const SOURCE_COMMENTARY = /^\s*the\s+requirement\s+(?:also\s+)?(?:explicitly\s+|specifically\s+)?(?:states|mentions|references|introduces|specifies|identifies|requires)\b[^:]*:?\s*/i;
/** Area-level text: its sentences belong to the area's introduction and to many requirements, not to one item. */
const NOT_AN_ITEM = /\b(?:overview|summary|introduction|background|scope|purpose|context)\b/i;
/** A source's numbered open items: "Gap 2: …", "Decision 5", "Risk 1 – …". */
const OPEN_ITEM = /^\s*(?:gap|decision|risk|assumption|open (?:item|question))\s*#?\d+\b/i;
const segmentsOf = (s: string) =>
  s.replace(/[*_`]/g, "").split(/[›>—–:“”"|;/()[\]]+|\s-\s/).map((x) => words(x).join(" ")).filter(Boolean);

type SourceItem = { key: string; title: string; path: string[]; body: string; level?: number; areaLevel?: number };

/** Every heading of a source with its own text up to the next heading, and the headings above it. */
function sourceItems(key: string, text: string): SourceItem[] {
  const out: SourceItem[] = [];
  const stack: { level: number; title: string }[] = [];
  let cur: SourceItem | null = null;
  // The document's area level: its "##" headings, or its "#" headings when it has no "##" (as areaHeadings does).
  const areaLevel = /^##\s/m.test(text) ? 2 : 1;
  for (const line of text.split(/\r?\n/)) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length, title = h[2].replace(/[*_`#]/g, "").trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      cur = { key, title, path: stack.map((s) => s.title), body: "", level, areaLevel };
      out.push(cur);
      stack.push({ level, title });
    } else if (cur) cur.body += line + "\n";
  }
  return out;
}

/**
 * Sentences of a cited source item that no requirement citing that item carries. A requirement names
 * its item in its Source Reference ("… › Requirement Breakdown › Fleet Commitment: “…”"); the item's own
 * text runs to the next heading. Every sentence of it should be in one of the requirements that cite it:
 * graders marked four of five MINORs on run 38 for a dropped sentence of the item (a purpose sentence,
 * the explanation under each option, a general sentence folded into an example). Advisory: a sentence
 * whose word pairs are mostly present counts as carried, and the source's own speculation is exempt.
 */
export function omittedItemSentences(
  doc: string, sources: Map<string, string>,
  /** Filled with the cited items too long to check (over 2,500 characters), so they can be reported as unchecked, not passed. */
  unchecked: string[] = []
): OmittedItemSentence[] {
  const byItem = itemCitations(doc, [...sources].flatMap(([k, t]) => sourceItems(k, t)));
  const out: OmittedItemSentence[] = [];
  for (const [it, e] of byItem) {
    // An area-sized section is not an item: its sentences belong to many requirements.
    // A Gap, Decision or Risk is cited in Open Questions for what it asks, not carried sentence by sentence: on a
    // Golden-Repository BRD they were a third of this check's flags ("Decision 5 | Examples: Any overdue invoice …").
    if (NOT_AN_ITEM.test(it.title) || OPEN_ITEM.test(it.title)) continue;
    // A document's own sections at area level are not items either: a project form's "## Constraints" field holds many
    // constraints, and each requirement carries the one it states, not the whole field (59 false findings in one run).
    if ((it.level ?? 99) <= (it.areaLevel ?? 0)) continue;
    if (it.body.length > 2500) { unchecked.push(`${it.title} (${e.reqs.join(", ")})`); continue; }
    const have = bigramSet(e.text.join("\n"));
    for (const s of itemSentences(it.body)) {
      const bg = bigramList(contentWords(s));
      if (bg.filter((b) => have.has(b)).length / bg.length < 0.5) out.push({ reqs: e.reqs, item: it.title, sentence: s });
    }
  }
  return out;
}

/** The sentences of an item that a requirement must carry: not table rows, links, lead-ins, questions, the source's speculation. */
function itemSentences(body: string): string[] {
  const out: string[] = [];
  for (const raw of joinLeadIns(body).split(/(?<=[.!?])\s+|\n+/).map((s) => plain(s).replace(/\s+/g, " ").trim())) {
    if (raw.startsWith("|") || /\]\(https?:|https?:\/\//.test(raw) || /:\s*$/.test(raw)) continue;
    // "This suggests <a conclusion>." is the source's speculation; "This suggests … may need to track: A, B, C" carries a list.
    if (raw.includes("?") || (SOURCE_INFERENCE.test(raw) && !raw.includes(":"))) continue;
    const s = raw.replace(SOURCE_COMMENTARY, "");
    if (bigramList(contentWords(s)).length >= 3) out.push(s);
  }
  return out;
}

/**
 * The source items each requirement cites: the headings its Source Reference names as a whole segment, in a source it
 * cites. Of headings with the same title, the one whose own path the reference also names ("LDW Configuration" sits in
 * two areas). Items with no text of their own are skipped.
 */
function itemCitations(doc: string, items: SourceItem[], requireBody = true): Map<SourceItem, { reqs: string[]; text: string[] }> {
  const byItem = new Map<SourceItem, { reqs: string[]; text: string[] }>();
  for (const block of requirementBlocks(doc)) {
    const id = DEFINES_ID.exec(block.split("\n")[0]);
    const ref = fieldValue(block, "Source References?") ?? undefined;
    if (!id || !ref) continue;
    const keys = citedKeys(ref);
    const segs = segmentsOf(ref);
    const has = (title: string) => {
      const ts = segmentsOf(title);
      return ts.length > 0 && segs.some((_, i) => ts.every((t, k) => segs[i + k] === t));
    };
    // Each item the reference names as a whole segment; of headings with the same title, the one whose own path
    // the reference also names ("LDW Configuration" sits in two areas). Items with no text of their own are skipped.
    const named = items.filter((it) => keys.includes(it.key) && (!requireBody || it.body.trim()) && has(it.title));
    const best = new Map<string, { it: SourceItem; score: number }>();
    for (const it of named) {
      const score = it.path.filter(has).length;
      const k = `${it.key}\n${it.title.toLowerCase()}`;
      if (!best.has(k) || score > best.get(k)!.score) best.set(k, { it, score });
    }
    for (const { it } of best.values()) {
      const e = byItem.get(it) ?? { reqs: [], text: [] };
      e.reqs.push(`${id[3]}-${id[4]}`);
      e.text.push(block);
      byItem.set(it, e);
    }
  }
  return byItem;
}

// --- Sequences kept as sequences -------------------------------------------------------------

export type FlattenedSequence = { req: string; item: string; sequence: string[]; problem: "order" | "list" };

const ARROW_LINE = /^\s*(?:↓|⬇|→|->|⟶|=>)\s*$/;
const SEQUENCE_MARK = /→|->|↓|⟶|=>|>|\bthen\b|\bfollowed by\b|\bbecomes\b|\bmoves to\b/i;

/**
 * The chains a source draws with arrows, one step per line and an arrow line between ("Available / ↓ / Reserved / ↓ /
 * Scheduled for Delivery …"), or on one line ("Quote → Reservation → Agreement"). Only chains of three or more steps: a
 * two-step "condition ↓ effect" pair is a rule, not a sequence.
 */
export function sourceSequences(text: string): string[][] {
  const out: string[][] = [];
  const lines = text.split(/\r?\n/).map((l) => plain(l).trim()).filter(Boolean);
  let chain: string[] = [];
  let lastWasArrow = false;
  const flush = () => { if (chain.length >= 3) out.push(chain); chain = []; };
  for (const l of lines) {
    if (ARROW_LINE.test(l)) { lastWasArrow = chain.length > 0; continue; }
    const inline = l.split(/\s*(?:→|->|⟶|=>)\s*/).map((x) => x.trim()).filter(Boolean);
    if (inline.length >= 3 && inline.every((x) => x.length <= 60)) { flush(); out.push(inline); lastWasArrow = false; continue; }
    if (lastWasArrow && l.length <= 60) chain.push(l);
    else { flush(); chain = l.length <= 60 ? [l] : []; }
    lastWasArrow = false;
  }
  flush();
  return out;
}

/**
 * A source sequence that a requirement citing its item lists out of order, or as a plain list with nothing marking the
 * sequence between the steps. Twice in a row graders marked "Available ↓ Reserved ↓ … ↓ On Rent" written as "Available,
 * Reserved, …, On Rent" (runs 45 and 46): the order is part of what the source says. Only requirements citing the item
 * that holds the chain are compared, so the same words in another list ("credit checks during Quote, Reservation,
 * Agreement") are not taken for it.
 */
export function flattenedSequences(doc: string, sources: Map<string, string>): FlattenedSequence[] {
  const items = [...sources].flatMap(([k, t]) => sourceItems(k, t));
  const out: FlattenedSequence[] = [];
  for (const [it, e] of itemCitations(doc, items)) {
    const seqs = sourceSequences(it.body);
    // Two chains of the same steps in different orders are examples of a choice ("Customer → Equipment → Pricing" and
    // "Customer → Pricing → Equipment" under Section Ordering), not one order to keep.
    const setKey = (s: string[]) => s.map((x) => x.toLowerCase()).sort().join("\n");
    const alternatives = new Set(seqs.map(setKey).filter((k, i, all) => all.indexOf(k) !== i));
    for (const seq of seqs.filter((s) => !alternatives.has(setKey(s)))) {
      e.text.forEach((block, bi) => {
        // The requirement's own words: the Source Reference quotes the source and would match itself.
        const own = block.replace(/(?:\*\*)?Source References?(?:\*\*)?\s*:[\s\S]*?(?=\n\s*(?:[-*]\s+)?(?:\*\*)?[A-Z][A-Za-z ]{2,40}(?:\*\*)?\s*:|\n\s*-{3,}|$)/i, "");
        const low = own.toLowerCase();
        const found = seq.map((s, i) => ({ i, at: low.indexOf(s.toLowerCase()) })).filter((x) => x.at >= 0);
        if (found.length < 3) return;
        const byPos = [...found].sort((a, b) => a.at - b.at);
        const req = e.reqs[bi];
        if (byPos.some((x, k) => k > 0 && x.i < byPos[k - 1].i)) { out.push({ req, item: it.title, sequence: seq, problem: "order" }); return; }
        const gaps = byPos.slice(1).map((x, k) => low.slice(byPos[k].at + seq[byPos[k].i].length, x.at));
        if (!gaps.some((g) => SEQUENCE_MARK.test(g))) out.push({ req, item: it.title, sequence: seq, problem: "list" });
      });
    }
  }
  return out;
}

export function formatFlattenedSequences(f: FlattenedSequence[], max = 10): string | null {
  if (!f.length) return null;
  return (
    `⚠ **Source sequences not kept as sequences — ${f.length}:**\n` +
    f.slice(0, max).map((x) => `- ${x.req} — ${x.item}: ${x.problem === "order" ? "steps out of the source's order" : "steps listed without their order"}; the source reads “${x.sequence.join(" → ")}”`).join("\n") +
    (f.length > max ? `\n- …and ${f.length - max} more.` : "") +
    `\nWrite the steps in the source's order as a sequence (A → B → C), keeping its hedge ("may include", "potential").`
  );
}

// --- Every source item accounted for -------------------------------------------------------

export type ItemDisposition =
  | { status: "covered"; item: string; source: string; reqs: string[] }
  /** No requirement names it; one names the item it sits under. Counted apart, so "covered" cannot hide a dropped child. */
  | { status: "covered-via-parent"; item: string; source: string; reqs: string[] }
  | { status: "unresolved"; item: string; source: string; reqs: string[] }
  | { status: "excluded"; item: string; source: string }
  | { status: "not-covered"; item: string; source: string };
export type ItemLedger = { items: ItemDisposition[]; noItems: string[] };

/** The analyst's own sections of a requirements document: their headings are commentary, not requirement items. */
const ANALYST_SECTION = /\b(?:our understanding|discovery|implications|build inputs|information missing|requirement gaps|business decisions|risks?|ambiguit(?:y|ies)|glossary|definitions?|references?|appendix|open (?:items|questions)|assumptions?)\b/i;
const EXCLUSION = /\b(?:out of (?:the )?(?:approved )?scope|excluded|not (?:in|part of) (?:the )?(?:approved )?scope)\b/i;

/**
 * Whether a line of the document excludes this item: the item's title, as whole words, within 8 words of the exclusion
 * phrase. A short title ("Notes", "Status") counts only at two words or 8 characters, so an unrelated out-of-scope line
 * that happens to contain the word does not exclude it.
 */
function excludedIn(lines: string[], title: string): boolean {
  const t = words(title);
  if (t.length < 2 && t.join(" ").length < 8) return false;
  for (const line of lines) {
    const w = words(line);
    const phrase = words(EXCLUSION.exec(line)?.[0] ?? "");
    // Every place each occurs: a line may name the title twice, only once near the phrase.
    const at = (needle: string[]) => w.flatMap((_, i) => (needle.length && needle.every((x, k) => w[i + k] === x) ? [i] : []));
    for (const ti of at(t)) for (const pi of at(phrase)) {
      const gap = ti < pi ? pi - (ti + t.length) : ti - (pi + phrase.length);
      if (gap <= 8) return true;
    }
  }
  return false;
}

/**
 * Every requirement item of the client's documents with what became of it: covered (a requirement's Source Reference names
 * it), unresolved (no requirement names it, but one carries most of a sentence of it: a match to confirm, never a guessed
 * one), excluded (the document says it is out of scope), or not covered. An item is a heading with no sub-headings and text
 * of its own, below the area level, outside the analyst's sections and open items. A document with no headings has no
 * items to account for and is named, so its silence does not read as full coverage.
 */
export function itemLedger(doc: string, sources: Map<string, string>): ItemLedger {
  const all = [...sources].flatMap(([k, t]) => {
    const its = sourceItems(k, t);
    const levels = t.split(/\r?\n/).map((l) => /^(#{1,6})\s/.exec(l)?.[1].length ?? 0);
    const areaLevel = levels.includes(2) ? 2 : 1;
    // Level of each item, to find leaves: an item is a leaf when the next heading is not below it.
    const headingLevels = levels.filter(Boolean);
    return its.map((it, i) => ({ it, level: headingLevels[i], next: headingLevels[i + 1] ?? 0, areaLevel }));
  });
  // The whole path is checked: a live source put "# Product & Screen Implications" at the top level inside an area.
  const leaves = all.filter(({ it, level, next, areaLevel }) =>
    level > areaLevel && !(next > level) && it.body.trim().length >= 20 &&
    !NOT_AN_ITEM.test(it.title) && !OPEN_ITEM.test(it.title) && !ANALYST_SECTION.test(it.title) &&
    !it.path.some((p) => ANALYST_SECTION.test(p) || OPEN_ITEM.test(p))).map((x) => x.it);
  const noItems = [...sources.keys()].filter((k) => !leaves.some((it) => it.key === k));
  const cited = itemCitations(doc, leaves);
  // A requirement that cites an item covers its sub-headings too ("Equipment Class" under "LDW Configuration").
  const citedParents = new Map<string, string[]>();
  // Only a parent that is an item itself — below the area, with text of its own — not a container such as the area
  // or "Requirement Breakdown", which every reference names on its way to the item.
  const parents = all.filter(({ it, level, areaLevel }) => level > areaLevel && it.body.trim().length >= 20).map((x) => x.it);
  for (const [it, e] of itemCitations(doc, parents, false)) {
    const k = `${it.key}\n${[...it.path, it.title].join("\n")}`;
    citedParents.set(k, [...(citedParents.get(k) ?? []), ...e.reqs]);
  }
  const viaParent = (it: SourceItem): string[] | null => {
    for (let n = it.path.length; n > 0; n--) {
      const r = citedParents.get(`${it.key}\n${it.path.slice(0, n).join("\n")}`);
      if (r) return r;
    }
    return null;
  };
  const blocks = requirementBlocks(doc);
  const blockSets = blocks.map((b) => bigramSet(b));
  const exclusionLines = doc.split(/\r?\n/).filter((l) => EXCLUSION.test(l));
  const items: ItemDisposition[] = leaves.map((it) => {
    const e = cited.get(it);
    if (e) return { status: "covered", item: it.title, source: it.key, reqs: e.reqs };
    const parent = viaParent(it);
    if (parent) {
      // Covered through the parent only if the parent's requirements carry what the child says (half or more of each of
      // its sentences' word pairs); otherwise the child is unresolved — a parent citation must not hide a dropped child.
      const ids = [...new Set(parent)];
      const have = bigramSet(blocks.filter((b) => { const m = DEFINES_ID.exec(b.split("\n")[0]); return !!m && ids.includes(`${m[3]}-${m[4]}`); }).join("\n"));
      const carried = itemSentences(it.body).every((s) => { const bg = bigramList(contentWords(s)); return bg.filter((b) => have.has(b)).length / bg.length >= 0.5; });
      return { status: carried ? "covered-via-parent" : "unresolved", item: it.title, source: it.key, reqs: ids };
    }
    if (excludedIn(exclusionLines, it.title)) return { status: "excluded", item: it.title, source: it.key };
    // A requirement that carries most of one of the item's sentences without naming the item: unresolved, to confirm.
    // 0.6 of the sentence's word pairs, set on 2026-11-22 against runs 40 and 45 and a one-pass golden-only BRD: it marked
    // REQ-074 (named for an item, citing the Overview) and REQ-027 (four items merged) unresolved and nothing in run 45.
    const reqs = new Set<string>();
    for (const s of itemSentences(it.body)) {
      const bg = bigramList(contentWords(s));
      blockSets.forEach((set, i) => {
        if (bg.filter((b) => set.has(b)).length / bg.length >= 0.6) {
          const id = DEFINES_ID.exec(blocks[i].split("\n")[0]);
          if (id) reqs.add(`${id[3]}-${id[4]}`);
        }
      });
    }
    return reqs.size ? { status: "unresolved", item: it.title, source: it.key, reqs: [...reqs] } : { status: "not-covered", item: it.title, source: it.key };
  });
  return { items, noItems };
}

/** One line for the run's log and notice: every status counted, and the documents not checked item by item. */
export function summarizeItemLedger(l: ItemLedger): string {
  const n = (s: ItemDisposition["status"]) => l.items.filter((x) => x.status === s).length;
  return `source items: ${l.items.length} — ${n("covered")} covered, ${n("covered-via-parent")} covered via parent, ${n("unresolved")} unresolved, ${n("excluded")} excluded, ${n("not-covered")} not covered` +
    (l.noItems.length ? `; not checked item by item (no headings): ${l.noItems.join(", ")}` : "");
}

/**
 * The client documents with no headings to treat as items, said even when every item that could be checked is covered:
 * otherwise "nothing missing" reads as full coverage of documents that were never checked item by item.
 */
export function formatUncheckedDocuments(l: ItemLedger): string | null {
  const n = (s: ItemDisposition["status"]) => l.items.filter((x) => x.status === s).length;
  if (!l.noItems.length || n("not-covered") || n("unresolved")) return null; // formatItemLedger already names them
  return `ℹ **Not checked item by item: ${l.noItems.join(", ")}** (no headings to treat as items). The ${l.items.length} item(s) of the other documents are all accounted for; read these documents against the requirements yourself.`;
}

/** What the writer must act on: items no requirement covers, and matches to confirm. Null when there are none. */
export function formatItemLedger(l: ItemLedger, max = 15): string | null {
  const by = (s: ItemDisposition["status"]) => l.items.filter((x) => x.status === s);
  const covered = by("covered"), viaParent = by("covered-via-parent"), unresolved = by("unresolved"), excluded = by("excluded"), missing = by("not-covered");
  if (!missing.length && !unresolved.length) return null;
  const lines: string[] = [];
  lines.push(`${missing.length ? "⚠" : "ℹ"} **Source items: ${l.items.length} in the client's documents — ${covered.length} covered, ${viaParent.length} covered via parent, ${unresolved.length} unresolved, ${excluded.length} excluded, ${missing.length} not covered.**`);
  if (missing.length)
    lines.push(`Not covered by any requirement:\n` + missing.slice(0, max).map((x) => `- ${x.item} (${x.source})`).join("\n") + (missing.length > max ? `\n- …and ${missing.length - max} more.` : "") +
      `\nWrite a requirement for each, citing the item's heading in its Source Reference, or say in the document why it is out of scope.`);
  if (unresolved.length)
    lines.push(`Unresolved — a requirement carries its text but does not cite the item; confirm and cite it:\n` +
      unresolved.slice(0, max).map((x) => `- ${x.item} (${x.source}) — ${"reqs" in x ? x.reqs.join(", ") : ""}`).join("\n") + (unresolved.length > max ? `\n- …and ${unresolved.length - max} more.` : ""));
  if (l.noItems.length)
    lines.push(`ℹ Not checked item by item (no headings to treat as items): ${l.noItems.join(", ")}.`);
  return lines.join("\n");
}

/** Cited items too long to check sentence by sentence: said, so that silence does not read as "nothing left out". */
export function formatUncheckedItems(unchecked: string[], max = 8): string | null {
  if (!unchecked.length) return null;
  return (
    `ℹ **Not checked for left-out sentences: ${unchecked.length} long source item(s)** (over 2,500 characters): ` +
    unchecked.slice(0, max).join("; ") + (unchecked.length > max ? `; …and ${unchecked.length - max} more` : "") +
    `. Read each against the requirements that cite it.`
  );
}

export function formatOmittedItemSentences(o: OmittedItemSentence[], max = 15): string | null {
  if (!o.length) return null;
  return (
    `⚠ **Source item sentences no requirement carries — ${o.length}** (each requirement below cites the item, but none of them states this sentence):\n` +
    o.slice(0, max).map((x) => `- ${x.reqs.join(", ")} — ${x.item}: “${x.sentence.slice(0, 220)}”`).join("\n") +
    (o.length > max ? `\n- …and ${o.length - max} more.` : "") +
    `\nCarry each in the requirement that cites the item, in the source's own words and strength: a purpose sentence ("This prevents…"), ` +
    `the explanation under each option, a general statement that follows an example. Do not turn it into a new obligation. ` +
    `If a sentence belongs to another requirement, cite the item there too.`
  );
}
