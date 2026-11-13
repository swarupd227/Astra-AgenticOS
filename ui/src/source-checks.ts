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
      const block = [line];
      while (i + 1 < lines.length && labelled.test(lines[i + 1])) block.push(lines[++i]);
      const text = block.join("\n");
      const stmt = block.find((l) => /^\s*\*\*(?:Requirement )?Statement:\*\*/i.test(l));
      units.push({ text, claim: plain((stmt ?? block.filter((l) => !/Source|Priority|Dependenc|Open Question/i.test(l)).join(" ")).replace(/^\s*\*\*[^*]+:\*\*/, "")) });
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
    const value = m[1].replace(/[*_\s]+$/g, "").trim();
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

type Sentences = { text: string; bi: Set<string> }[];
/** Per call, never kept: the same citation id can name different text on the next save. */
function sentencesOf(cache: Map<string, Sentences>, key: string, text: string): Sentences {
  let s = cache.get(key);
  if (!s) {
    s = text.split(/(?<=[.!?])\s+|\n+/).map((t) => t.trim()).filter((t) => t.length > 20 && !t.includes("?"))
      .map((t) => ({ text: t, bi: new Set(bigramList(contentWords(t))) }));
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
    const claimLevel = strengthOf(u.claim);
    if (claimLevel === null) continue;
    const claimBi = bigramList(contentWords(u.claim));
    if (claimBi.length < MIN_BIGRAMS) continue;
    for (const c of new Set((u.text.match(CITE) ?? []).map(citationKey))) {
      const text = sources.get(c);
      if (!text) continue;
      let best: { text: string; shared: number; ratio: number } | null = null;
      for (const s of sentencesOf(cache, c, text)) {
        let shared = 0; for (const b of claimBi) if (s.bi.has(b)) shared++;
        const ratio = s.bi.size ? shared / s.bi.size : 0;
        if (shared >= 3 && ratio >= 0.5 && (!best || shared > best.shared || (shared === best.shared && ratio > best.ratio))) best = { text: s.text, shared, ratio };
      }
      if (!best) continue;
      const hedged = HEDGE.test(best.text) && !HEDGE.test(u.claim);
      // A hedged source sits below "may": any modal the claim adds to it is stronger than the source.
      const srcLevel = hedged ? -1 : strengthOf(best.text);
      const base = { citation: c, claim: u.claim.replace(/\s+/g, " ").slice(0, 120), claimWord: strongestWord(u.claim), sourceWord: hedged ? (best.text.match(HEDGE)?.[0].toLowerCase() ?? "suggests") : strongestWord(best.text), sourceSentence: best.text.replace(/\s+/g, " ").slice(0, 140) };
      if (srcLevel !== null && claimLevel > srcLevel) out.push(base);
      else if (srcLevel === 2 && claimLevel < 2) out.push({ ...base, direction: "weakened" });
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

  const fromSources = new Set<string>();
  for (const t of sourceTexts) for (const m of t.matchAll(/\b[A-Z]{2,6}-\d{1,4}\b/g)) fromSources.add(m[0]);
  const defined = new Set<string>();
  const referenced = new Set<string>();
  for (const l of lines) {
    // An ID defines itself when it opens the item and is followed by its title or text, not by a bare aside:
    // "- OQ-012 (to be raised with Finance)" mentions OQ-012 and says nothing about what it is.
    const lead = /^\s*(?:#{1,6}\s+|[-*+]\s+|\|\s*|\d+\.\s+)?(?:\*\*|__)?\s*([A-Z]{1,6}-\d{1,4})(?:\*\*|__)?\s*(?:[—–:.|-]\s*)?(?![(\[])(\S.*)?$/.exec(l);
    if (lead && (lead[2] ?? "").trim().length >= 3) defined.add(lead[1]);
    else if (lead && /^\s*(?:#{1,6}\s+|\|)/.test(l)) defined.add(lead[1]); // a bare heading or table cell is a definition
  }
  for (const m of doc.matchAll(/\b([A-Z]{1,6})-(\d{1,4})\b/g)) {
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
  const blocks = requirementBlocks(doc);
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

export function formatCoverageGaps(g: { scopeLines: number; gaps: CoverageGap[] }, max = 12): string | null {
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

// The noun only: "depends on" turns up in every descriptive sentence, "a dependency on X" is a statement of one.
const DEPENDS = /\bdependenc(?:y|ies)\b/i;
const INSTRUCTION = /\b(?:do not|don't|must not|never|only (?:if|where|when)|avoid|ensure that|ensure the|should be stated)\b/i;

/** Source sentences that state a dependency which appears nowhere in the document. */
export function omittedDependencies(doc: string, sourceTexts: string[]): OmittedDependency[] {
  const have = bigramSet(doc);
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
    `\nPut each on the requirement it concerns, quoting the sentence: \`Dependencies: REQ-nnn — “the quoted sentence”\`. Leaving "Not specified" is right only where no source says so.`
  );
}

// --- Quotes must be verbatim --------------------------------------------------------------

export type QuoteIssue = { quote: string; kind: "reworded" | "not-in-any-source" };

/**
 * Text inside quotation marks is a promise that a source says exactly this. A live document put a
 * bullet list from a source inside one pair of quotes as if it were one sentence, and altered
 * spelling inside quote marks; both read as verbatim and are not. Fragments split on "…" are
 * checked one by one.
 */
export function quoteIssues(doc: string, sourceTexts: string[]): { checked: number; issues: QuoteIssue[] } {
  const hay = ` ${sourceTexts.map(plainKey).join(" ")} `;
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
    (i) => `- “${i.quote}” — ${i.kind === "reworded" ? "close to a source, but not the source's words" : "no source contains this"}`
  );
  return (
    `⚠ **Quotation marks around text that is not verbatim — ${r.issues.length} of ${r.checked} quoted passages:**\n${lines.join("\n")}` +
    (r.issues.length > max ? `\n- …and ${r.issues.length - max} more.` : "") +
    `\nInside quotation marks, copy the source exactly (use “…” to skip words). To summarise a list or paraphrase, drop the quotation marks and cite the source.`
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
    const value = m[2].replace(/[*_.\s]+$/g, "").trim();
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
