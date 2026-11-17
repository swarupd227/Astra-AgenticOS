/**
 * Three checks on what a requirement says about the gaps, decisions and lists its source contains.
 *
 * Reviewers of live runs kept finding the same small drift after the wording checks had passed:
 * an open question filed under "Gaps 1 and 2" of a section that has Gaps 1, 3 and 4; "None" as the
 * open questions of a requirement whose section lists gaps about it; a list of eleven items written
 * as nine. None of these is a wording problem, so the citation and strength checks cannot see them.
 *
 * Heuristics over text, like the rest of source-checks.ts: each reports what it compared.
 */
import { citedKeys, contentWords, requirementBlocks, stem } from "./source-checks.js";

const stems = (text: string) => new Set(contentWords(text).map(stem));
const sharedCount = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n; };

// --- what the sources list ---------------------------------------------------------------

export type SourceItem = { kind: "Gap" | "Decision"; n: number; title: string; text: string; source: string };

const ITEM_HEAD = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(Gap|Decision)\s+(\d{1,2})\b\s*(?:\*\*|__)?\s*[:.\-–—]?\s*(?:\*\*|__)?\s*(.*?)\s*(?:\*\*|__)?\s*$/i;
const HEADING = /^\s*#{1,6}\s/;

/** "#### Gap 2: Credit Status Lifecycle" and "#### Decision 4", with the lines under them. */
export function sourceItems(text: string, source: string): SourceItem[] {
  const out: SourceItem[] = [];
  let cur: { item: SourceItem; body: string[] } | null = null;
  const close = () => { if (cur) { cur.item.text = `${cur.item.title}\n${cur.body.join("\n")}`.slice(0, 1500); out.push(cur.item); cur = null; } };
  for (const line of text.split(/\r?\n/)) {
    const m = ITEM_HEAD.exec(line);
    // Prose that merely begins "Decision 3 is…" is not an item: it has to be a heading, bold, or followed by a colon.
    if (m && (HEADING.test(line) || /^\s*(?:\*\*|__)/.test(line) || /^\s*(?:Gap|Decision)\s+\d{1,2}\s*:/i.test(line))) {
      close();
      cur = { item: { kind: /^g/i.test(m[1]) ? "Gap" : "Decision", n: Number(m[2]), title: m[3].replace(/[*_]+/g, "").trim(), text: "", source }, body: [] };
    } else if (cur) {
      if (HEADING.test(line)) close();
      else cur.body.push(line);
    }
  }
  close();
  return out;
}

/** One requirement: its id, the field text by label, and the sources it cites. */
type Req = { id: string; fields: Map<string, string>; cited: string[] };

function requirementsOf(doc: string): Req[] {
  const out: Req[] = [];
  for (const block of requirementBlocks(doc)) {
    const id = /\b[A-Z]{1,6}-\d{1,4}\b/.exec(block)?.[0];
    if (!id) continue;
    const fields = new Map<string, string>();
    // A field runs to the next **Label:** or the end of the block, whether its value sits on one line or several.
    const parts = block.split(/^\s*\*\*([^*\n]+?):\*\*[ \t]*/m);
    for (let i = 1; i + 1 < parts.length; i += 2) fields.set(parts[i].trim().toLowerCase(), parts[i + 1].replace(/\n\s*-{3,}\s*$/, "").trim());
    out.push({ id, fields, cited: citedKeys(block) });
  }
  return out;
}

const field = (r: Req, re: RegExp) => { for (const [k, v] of r.fields) if (re.test(k)) return v; return ""; };

// --- 1. Gap and Decision numbers that cite something else ---------------------------------

export type GapCitationIssue = { requirement: string; ref: string; reason: "missing" | "mismatch"; closest?: string };

const REF = /\b(Gap|Decision)s?\s+(\d{1,2})((?:\s*(?:,|and|&)\s*\d{1,2}(?!\d))*)/gi;

/**
 * "(Source: … — Post Billing / Pre Billing, Gaps 1 and 2)" names items by number. The number is what a
 * reader follows to the source, so each cited Gap or Decision has to exist and has to be about the question
 * it is cited for. Matched on content, because the sources repeat "Gap 1" in every topic: some Gap 2 in the
 * cited document must share the question's words, or the number is wrong.
 */
export function gapCitationIssues(doc: string, sources: Map<string, string>): { checked: number; issues: GapCitationIssue[] } {
  const issues: GapCitationIssue[] = [];
  let checked = 0;
  const itemsOf = new Map<string, SourceItem[]>();
  for (const r of requirementsOf(doc)) {
    const oq = field(r, /^open questions?$/);
    if (!oq) continue;
    const refs: { kind: "Gap" | "Decision"; n: number }[] = [];
    for (const m of oq.matchAll(REF)) {
      const kind = /^g/i.test(m[1]) ? "Gap" : "Decision";
      for (const n of [m[2], ...(m[3].match(/\d+/g) ?? [])]) refs.push({ kind, n: Number(n) });
    }
    if (!refs.length) continue;
    const files = citedKeys(oq).filter((k) => k.startsWith("inputs/") && sources.has(k));
    // A question that names a document the server does not hold cannot be checked against another one.
    if (!files.length && citedKeys(oq).some((k) => k.startsWith("inputs/"))) continue;
    const use = files.length ? files : r.cited.filter((k) => k.startsWith("inputs/") && sources.has(k));
    const items = use.flatMap((k) => { if (!itemsOf.has(k)) itemsOf.set(k, sourceItems(sources.get(k)!, k)); return itemsOf.get(k)!; });
    if (!items.length) continue;
    // The questions: the field without its source parentheses and without the references themselves.
    const question = stems(oq.replace(/\([^()]*\bSource[^()]*\)/gi, " ").replace(REF, " "));
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = `${ref.kind} ${ref.n}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checked++;
      const candidates = items.filter((i) => i.kind === ref.kind && i.n === ref.n);
      if (!candidates.length) { issues.push({ requirement: r.id, ref: key, reason: "missing" }); continue; }
      if (Math.max(...candidates.map((c) => sharedCount(question, stems(c.text)))) >= 3) continue;
      const near = items.map((i) => ({ i, s: sharedCount(question, stems(i.text)) })).filter((x) => x.s >= 3 && !(x.i.kind === ref.kind && x.i.n === ref.n)).sort((a, b) => b.s - a.s)[0];
      issues.push({ requirement: r.id, ref: key, reason: "mismatch", closest: near ? `${near.i.kind} ${near.i.n}${near.i.title ? ` “${near.i.title}”` : ""}` : undefined });
    }
  }
  return { checked, issues };
}

export function formatGapCitations(r: { checked: number; issues: GapCitationIssue[] }, max = 15): string | null {
  if (!r.issues.length) return null;
  const line = (i: GapCitationIssue) =>
    i.reason === "missing"
      ? `- ${i.requirement}: cites ${i.ref}, and the cited document has no ${i.ref}.`
      : `- ${i.requirement}: cites ${i.ref}, but no ${i.ref} in the cited document is about these questions${i.closest ? ` — closest is ${i.closest}` : ""}.`;
  return (
    `⚠ **Open questions cite Gaps or Decisions they do not match — ${r.issues.length} of ${r.checked} references:**\n` +
    r.issues.slice(0, max).map(line).join("\n") + (r.issues.length > max ? `\n- …and ${r.issues.length - max} more.` : "") +
    `\nOpen the source section and cite the number of the Gap or Decision that raises the question; if no item raises it, say the question is yours rather than the source's.`
  );
}

// --- 2. "None" where the source lists a gap about this ------------------------------------

export type HiddenGap = { requirement: string; items: string[] };

const NO_QUESTIONS = /^(?:none|not specified|no (?:open )?questions?|n\/a|nil|no information)\b/i;

/**
 * Open Questions written as "None" or "Not specified" for a requirement whose cited document lists a Gap
 * or Decision about the same thing. Reported with the items so the agent can look: the sources decide
 * whether it applies, and a requirement may truly have no question.
 */
export function hiddenGaps(doc: string, sources: Map<string, string>): HiddenGap[] {
  const out: HiddenGap[] = [];
  const itemsOf = new Map<string, SourceItem[]>();
  for (const r of requirementsOf(doc)) {
    const oq = field(r, /^open questions?$/).replace(/[*_]+/g, "").trim();
    if (!oq || !NO_QUESTIONS.test(oq)) continue;
    // Only the requirement's own words: its statement and name. The source reference quotes more than it asserts.
    const own = stems(`${field(r, /^(?:requirement )?statement$/)} ${field(r, /^requirement name$/)}`);
    if (own.size < 3) continue;
    const files = r.cited.filter((k) => k.startsWith("inputs/") && sources.has(k));
    const hits: { label: string; s: number }[] = [];
    for (const k of files) {
      if (!itemsOf.has(k)) itemsOf.set(k, sourceItems(sources.get(k)!, k));
      for (const i of itemsOf.get(k)!) {
        // The title is what the item is about; the body adds detail. Require most of the title to be in the requirement.
        // "Decision 4" has no title of its own; its first line is the question.
        const title = stems(i.title || i.text.split("\n").find((l, n) => n > 0 && l.trim()) || "");
        const body = stems(i.text.slice(0, 600));
        const s = sharedCount(own, body);
        if (s >= 5 && (title.size === 0 || sharedCount(own, title) >= Math.min(2, title.size))) hits.push({ label: `${i.kind} ${i.n}${i.title ? ` “${i.title}”` : ""}`, s });
      }
    }
    if (hits.length) out.push({ requirement: r.id, items: hits.sort((a, b) => b.s - a.s).slice(0, 2).map((h) => h.label) });
  }
  return out;
}

export function formatHiddenGaps(h: HiddenGap[], max = 12): string | null {
  if (!h.length) return null;
  return (
    `⚠ **Open Questions say none, but the cited document lists gaps or decisions on the same subject — ${h.length}:**\n` +
    h.slice(0, max).map((x) => `- ${x.requirement}: ${x.items.join("; ")}`).join("\n") + (h.length > max ? `\n- …and ${h.length - max} more.` : "") +
    `\nRead those items. If one raises a question this requirement depends on, record it under Open Questions with its number; if none does, keep "None" and move on.`
  );
}

// --- 3. A list in the source written as fewer items ---------------------------------------

export type NarrowedList = { requirement: string; citation: string; lead: string; present: number; total: number; missing: string[] };

const LIST_ITEM = /^\s*(?:[-*+•]\s+|\d+[.)]\s+)(.*\S)\s*$/;
const ILLUSTRATIVE = /\b(?:such as|including|for example|e\.g\.|among others|etc\.?|for instance|like)\b/i;

/** A word is named when the statement has it, or a longer or shorter form of it: "Misc Charges" is "miscellaneous charges". */
const named = (claim: Set<string>, w: string) => claim.has(w) || (w.length >= 4 && [...claim].some((c) => c.length >= 4 && (c.startsWith(w) || w.startsWith(c))));

/** Headings and lead-ins whose lists are questions, options or examples: nobody is bound to restate all of them. */
const NOT_AN_ENUMERATION = /\b(?:gaps?|decisions?|questions?|risks?|ambigu\w*|missing|clarif\w*|clarity|possible|potential|options?|alternatives?|examples?|emerge|assum\w*)\b/i;

/** Bullet lists under a lead-in line ending in a colon: [{ lead, items }]. */
function listsIn(text: string): { lead: string; items: string[] }[] {
  const lines = text.split(/\r?\n/);
  const out: { lead: string; items: string[] }[] = [];
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    if (HEADING.test(lines[i])) heading = lines[i];
    if (!/:\s*(?:\*\*|__)?\s*$/.test(lines[i]) || lines[i].trim().length < 4) continue;
    if (NOT_AN_ENUMERATION.test(heading) || NOT_AN_ENUMERATION.test(lines[i])) continue;
    const items: string[] = [];
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    while (j < lines.length) {
      const m = LIST_ITEM.exec(lines[j]);
      if (m) { items.push(m[1].replace(/[*_]+/g, "").trim()); j++; }
      else if (!lines[j].trim() && j + 1 < lines.length && LIST_ITEM.test(lines[j + 1])) j++;
      else break;
    }
    if (items.length) out.push({ lead: lines[i].replace(/[*_:]+/g, "").trim(), items });
  }
  return out;
}

/**
 * A requirement that restates a source list with some of its items left out. The statement is matched to
 * the list it reproduces: it names at least two of the list's items, and more than half of them, so it is
 * plainly that list and not a sentence that happens to mention one entry. A statement that says "such as"
 * is giving examples and is left alone.
 */
export function narrowedLists(doc: string, sources: Map<string, string>): NarrowedList[] {
  const out: NarrowedList[] = [];
  const listsOf = new Map<string, ReturnType<typeof listsIn>>();
  for (const r of requirementsOf(doc)) {
    const statement = field(r, /^(?:requirement )?statement$/).replace(/[*_]+/g, "");
    if (!statement || ILLUSTRATIVE.test(statement)) continue;
    const claim = stems(statement);
    // The requirement's own words and the passage it quotes: a list is the one it reproduces only if its lead-in is among them.
    const about = stems(`${statement} ${field(r, /^requirement name$/)} ${field(r, /^source reference$/)}`);
    for (const k of r.cited) {
      const text = sources.get(k);
      if (!text) continue;
      if (!listsOf.has(k)) listsOf.set(k, listsIn(text));
      let best: NarrowedList | null = null;
      for (const l of listsOf.get(k)!) {
        if (l.items.length < 4 || l.items.length > 20) continue;
        const lead = stems(l.lead);
        if (lead.size && sharedCount(lead, about) / lead.size < 0.5) continue;
        const present = l.items.filter((it) => { const s = stems(it); return s.size > 0 && [...s].every((w) => named(claim, w)); });
        const missing = l.items.filter((it) => !present.includes(it));
        if (present.length < 3 || !missing.length || present.length * 2 <= l.items.length) continue;
        if (!best || present.length > best.present) best = { requirement: r.id, citation: k, lead: l.lead, present: present.length, total: l.items.length, missing: missing.slice(0, 6) };
      }
      if (best) { out.push(best); break; }
    }
  }
  return out;
}

export function formatNarrowedLists(n: NarrowedList[], max = 12): string | null {
  if (!n.length) return null;
  return (
    `⚠ **A source list is restated with items left out — ${n.length}:**\n` +
    n.slice(0, max).map((x) => `- ${x.requirement}: names ${x.present} of the ${x.total} items in a list in \`${x.citation}\`; not named: ${x.missing.join("; ")}`).join("\n") +
    (n.length > max ? `\n- …and ${n.length - max} more.` : "") +
    `\nName every item the source lists, or say which requirement covers the rest. A shortened list reads as the whole requirement.`
  );
}
