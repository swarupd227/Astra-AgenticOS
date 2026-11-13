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
const contentWords = (s: string) => words(s).filter((w) => !STOP.has(w) && w.length >= 3);
/** Crude stemming: first five letters, so "billing" and "billed" meet. */
const stem = (w: string) => (w.length > 5 ? w.slice(0, 5) : w);

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

const CITE = /GLD-[A-Z]+-\d+(?:@\d+)?|inputs\/[^\s,;)\]*]+\.(?:md|txt)/gi;

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
      const block = [line];
      while (i + 1 < lines.length && labelled.test(lines[i + 1])) block.push(lines[++i]);
      const text = block.join("\n");
      const stmt = block.find((l) => /^\s*\*\*(?:Requirement )?Statement:\*\*/i.test(l));
      units.push({ text, claim: plain((stmt ?? block.filter((l) => !/Source|Priority|Dependenc|Open Question/i.test(l)).join(" ")).replace(/^\s*\*\*[^*]+:\*\*/, "")) });
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
    const claimBigrams = bigramList(contentWords(u.claim));
    if (claimBigrams.length < MIN_BIGRAMS) continue;

    for (const c of cites) {
      if (!sources.has(c)) { report.unverifiable++; continue; }
      report.checked++;
      const have = setFor(c, sources);
      const score = claimBigrams.filter((b) => have.has(b)).length / claimBigrams.length;
      if (score >= WEAK_BELOW) continue;

      let foundIn: string | undefined;
      for (const [label] of others) {
        const s = claimBigrams.filter((b) => setFor("other:" + label, new Map([["other:" + label, others.get(label)!]])).has(b)).length / claimBigrams.length;
        if (s >= 0.6) { foundIn = label; break; }
      }
      report.issues.push({
        kind: score < NOT_FOUND_BELOW ? "not-found" : "weak",
        citation: c, claim: u.claim.replace(/\s+/g, " ").slice(0, 140), score: +score.toFixed(2), ...(foundIn ? { foundIn } : {}),
      });
    }
  }
  return report;
}

export function formatCitationReport(r: CitationReport, max = 6): string | null {
  const hard = r.issues.filter((i) => i.kind === "not-found");
  if (!hard.length && !r.issues.length) return null;
  const shown = [...hard, ...r.issues.filter((i) => i.kind === "weak")].slice(0, max);
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
