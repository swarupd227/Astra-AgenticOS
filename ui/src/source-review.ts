/**
 * A second reader for documents written from source documents.
 *
 * The deterministic checks in source-checks.ts and source-gaps.ts compare wording. What reviewers of live runs
 * kept finding after those passed is judgment: two source items merged into one requirement, list items dropped,
 * a Gap number that raises a different question, Dependencies that say "Not specified" and then list some, a
 * condition the source never states. A model that did not write the requirement reads it against the sources
 * and reports what differs; the writer fixes it with patch_section.
 *
 * This module is the orchestration and the guards, with the model call injected so each can be tested:
 * batching, which requirements need reading, what the reviewer may claim (a quoted source wording must be in the
 * sources, or the finding is dropped), and how the findings are put to the writer.
 */
import { createHash } from "node:crypto";
import { reviewableBlocks } from "./source-checks.js";

export type IssueKind = "strength" | "merged" | "dropped" | "invented" | "citation" | "gap_ref" | "dependency" | "open_question" | "name" | "other";

export type ReviewIssue = {
  kind: IssueKind;
  /** The field of the requirement: Requirement Statement, Dependencies, Open Questions, … */
  field: string;
  problem: string;
  /** Source wording that shows the problem, verbatim. Required except where the problem is an absence. */
  source_wording?: string;
  /** The text to put in place of what is there, ready for patch_section. */
  fix?: string;
};

export type ReviewVerdict = { req: string; verdict: "pass" | "minor" | "fail"; issues: ReviewIssue[] };

export type SourceText = { name: string; text: string };

/** Asks the reviewing model about one batch of requirement blocks and returns its verdicts. */
export type AskReviewer = (batch: { req: string; block: string }[]) => Promise<ReviewVerdict[]>;

// --- the reviewer's brief --------------------------------------------------------------------------

export const REVIEW_SYSTEM =
  `You are an independent reviewer. You did not write the requirements you are given. Check each one against the source documents below and report only where it differs from them.\n\n` +
  `For each requirement check:\n` +
  `1. Source Reference: the cited document and section exist and say what is attributed; any quoted text is really there. Wording that came from a source that is not cited (the task prompt blended with a requirements document under one citation) is a citation problem.\n` +
  `2. Requirement Statement: same obligation strength as the source (must/shall, should, may; "contains" or "supports" is not "shall"); no added condition, actor, number or detail; no list item dropped; no two source requirements merged into one.\n` +
  `3. Priority: stated in a source or "Not specified". Nothing invented.\n` +
  `4. Dependencies: only links a source states. A gap, a risk or the writer's own inference is not a dependency. "Not specified" followed by a dependency contradicts itself.\n` +
  `5. Open Questions: a Gap or Decision number that is cited must be the item that raises the question. "None" is wrong where the sources show a gap or ambiguity about this requirement. Do not demand questions the sources do not support.\n` +
  `6. Requirement Name: adds no detail the source lacks.\n\n` +
  `Rules:\n` +
  `- Be strict, but report a problem only if you can show it. Quote the source wording that proves it, verbatim, in source_wording. A finding whose quote is not in the sources is discarded.\n` +
  `- An absence ("no source states this condition") needs no quote: say what you searched for.\n` +
  `- verdict "fail" = invented or contradicted content, a wrong source, an obligation the source does not state. "minor" = drift that does not change what is required in substance. "pass" = nothing to report.\n` +
  `- Punctuation added to a quoted list, a different heading style, and an obviously shortened but accurate paraphrase are not problems.\n` +
  `- For each problem give fix: the exact replacement text for that field's wording, ready to substitute. If the right fix is to delete or add a sentence, say which in problem and give the sentence in fix.\n` +
  `- Account for every requirement you were given, by its ID, in exactly one place: in results if it has a problem (verdict minor or fail), or in passed if there is nothing to report. Do not write out passing requirements in results.`;

export const REVIEW_TOOL = {
  name: "report_review",
  description: "Report the review: the requirements with problems in results, the IDs of all the others in passed.",
  input_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        description: "Only the requirements that have a problem.",
        items: {
          type: "object",
          properties: {
            req: { type: "string", description: "The requirement's ID, for example REQ-014." },
            verdict: { type: "string", enum: ["pass", "minor", "fail"] },
            issues: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["strength", "merged", "dropped", "invented", "citation", "gap_ref", "dependency", "open_question", "name", "other"] },
                  field: { type: "string" },
                  problem: { type: "string" },
                  source_wording: { type: "string", description: "Verbatim source text that shows the problem." },
                  fix: { type: "string", description: "Replacement wording, ready to put in place of the current text." },
                },
                required: ["kind", "field", "problem"],
              },
            },
          },
          required: ["req", "verdict", "issues"],
        },
      },
      passed: {
        type: "array",
        description: "The ID of every requirement you were given that has nothing to report, for example [\"REQ-001\", \"REQ-004\"].",
        items: { type: "string" },
      },
    },
    required: ["results", "passed"],
  },
} as const;

/**
 * The same answer as a structured output (output_config.format). The shape is enforced by the API, so there is no
 * forced tool choice (which Sonnet 5.5 and Opus 5.5 reject) and no reply that silently skips the tool. Every property
 * is required and objects are closed, as structured outputs need; an absent quote or fix is an empty string.
 */
const ISSUE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["kind", "field", "problem", "source_wording", "fix"],
  properties: {
    kind: { type: "string", enum: ["strength", "merged", "dropped", "invented", "citation", "gap_ref", "dependency", "open_question", "name", "other"] },
    field: { type: "string" }, problem: { type: "string" },
    source_wording: { type: "string", description: "Verbatim source text that shows the problem; empty when the problem is an absence." },
    fix: { type: "string", description: "Replacement wording; empty if none." },
  },
} as const;
export const REVIEW_SCHEMA = {
  type: "object", additionalProperties: false, required: ["results", "passed"],
  properties: {
    results: {
      type: "array", description: "Only the requirements that have a problem.",
      items: { type: "object", additionalProperties: false, required: ["req", "verdict", "issues"], properties: { req: { type: "string" }, verdict: { type: "string", enum: ["pass", "minor", "fail"] }, issues: { type: "array", items: ISSUE_SCHEMA } } },
    },
    passed: { type: "array", items: { type: "string" }, description: "The ID of every requirement with nothing to report." },
  },
} as const;

/** The model's answer to REVIEW_TOOL as verdicts: its findings, plus a pass for each ID it listed as having none. */
export function coerceReview(input: unknown): ReviewVerdict[] {
  const o = (input && typeof input === "object" ? input : {}) as { results?: unknown; passed?: unknown };
  const found = coerceVerdicts(o.results);
  let passed: unknown = o.passed;
  if (typeof passed === "string") { try { passed = JSON.parse(passed); } catch { passed = (passed as string).split(/[\s,;]+/); } }
  const have = new Set(found.map((v) => v.req.trim().toUpperCase()));
  const ids = (Array.isArray(passed) ? passed : []).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => /^[A-Za-z]{1,6}-\d{1,4}$/.test(x));
  return [...found, ...ids.filter((id) => !have.has(id.toUpperCase())).map((req): ReviewVerdict => ({ req, verdict: "pass", issues: [] }))];
}

/** The sources as one block, each under its name, the same bytes for every batch so the model's prompt cache can hold it. */
export function sourcesBlock(sources: SourceText[]): string {
  return sources.map((s) => `=== SOURCE: ${s.name} ===\n${s.text}\n=== END OF ${s.name} ===`).join("\n\n");
}

export function batchPrompt(batch: { req: string; block: string }[]): string {
  return (
    `Review these ${batch.length} requirements against the sources. Report each by its ID.\n\n` +
    batch.map((b, i) => `----- Requirement ${i + 1}: ${b.req} -----\n${b.block.trim()}`).join("\n\n")
  );
}

/** The model's `results`, whatever shape it came back in: an array, or JSON text of one (a live run returned a string). */
export function coerceVerdicts(x: unknown): ReviewVerdict[] {
  let v = x;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is ReviewVerdict => !!e && typeof e === "object" && typeof (e as any).req === "string")
    .map((e) => ({ ...e, issues: Array.isArray(e.issues) ? e.issues.filter((i) => i && typeof i === "object") : [] }));
}

// --- guards on what the reviewer may claim ------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Whether wording quoted by the reviewer is in the sources, tolerant of markdown, punctuation and "…" for a skipped stretch. */
export function quoteInSources(quote: string, normalizedSources: string): boolean {
  const parts = quote.split(/…|\.{3}/).map(norm).filter((p) => p.length >= 12);
  if (!parts.length) return false;
  return parts.every((p) => normalizedSources.includes(p));
}

/** Findings that can be shown: a quote that is not in the sources, or no quote where one is needed, discards the finding. */
export function verifiedIssues(issues: ReviewIssue[], sources: SourceText[], normalizedSources = norm(sourcesBlock(sources))): { kept: ReviewIssue[]; dropped: number } {
  const needsNoQuote: IssueKind[] = ["invented", "dependency", "open_question"];
  const kept: ReviewIssue[] = [];
  for (const i of issues) {
    if (!i.problem?.trim()) continue;
    const q = i.source_wording?.trim();
    if (q ? quoteInSources(q, normalizedSources) : needsNoQuote.includes(i.kind)) kept.push(i);
  }
  return { kept, dropped: issues.length - kept.length };
}

// --- what has been read -----------------------------------------------------------------------------------

/** Which requirement text has been read and what came of it, so a requirement is read again only when it has changed. */
export class ReviewMemory {
  private readAt = new Map<string, string>();
  private open = new Map<string, { hash: string; verdict: "minor" | "fail"; issues: ReviewIssue[] }>();
  private rounds = new Map<string, number>();
  hash(block: string) { return createHash("sha1").update(norm(block)).digest("hex"); }

  needsReading(req: string, block: string, maxRounds: number): boolean {
    const h = this.hash(block);
    if (this.readAt.get(req) === h) return false;
    return (this.rounds.get(req) ?? 0) < maxRounds;
  }
  record(req: string, block: string, v: "pass" | "minor" | "fail", issues: ReviewIssue[]) {
    const h = this.hash(block);
    this.readAt.set(req, h);
    this.rounds.set(req, (this.rounds.get(req) ?? 0) + 1);
    if (v === "pass" || !issues.length) this.open.delete(req);
    else this.open.set(req, { hash: h, verdict: v === "fail" ? "fail" : "minor", issues });
  }
  /** Findings reported earlier on text that has not changed since. */
  stillOpen(blocks: { req: string; block: string }[]): string[] {
    return blocks.filter((b) => this.open.get(b.req)?.hash === this.hash(b.block)).map((b) => b.req);
  }
  roundsFor(req: string) { return this.rounds.get(req) ?? 0; }
  /** What was found when this exact text was last read, or null if it has not been read as it stands. */
  lastVerdict(req: string, block: string): { verdict: "pass" | "minor" | "fail"; issues: ReviewIssue[] } | null {
    const h = this.hash(block);
    if (this.readAt.get(req) !== h) return null;
    const o = this.open.get(req);
    return o && o.hash === h ? { verdict: o.verdict, issues: o.issues } : { verdict: "pass", issues: [] };
  }
}

export type ReviewReport = {
  read: number;
  total: number;
  /** New findings, from requirements read in this call. */
  findings: { req: string; verdict: "minor" | "fail"; issues: ReviewIssue[] }[];
  /** Requirements reported earlier whose text has not changed since. */
  stillOpen: string[];
  droppedClaims: number;
  /** Requirements the reviewer did not return a verdict for. */
  missing: string[];
};

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]); }
  }));
  return out;
}

/**
 * Read the requirements that are new or changed since they were last read, in batches. The first batch goes alone so
 * the sources are in the model's prompt cache for the rest, which then run side by side.
 */
export async function reviewDocument(opts: {
  doc: string; sources: SourceText[]; memory: ReviewMemory; ask: AskReviewer;
  batchSize?: number; concurrency?: number; maxRounds?: number;
  /** false when the caller has already put the sources in the prompt cache, so every batch can start at once. */
  firstAlone?: boolean;
}): Promise<ReviewReport> {
  const { doc, sources, memory, ask } = opts;
  const size = opts.batchSize ?? 8, maxRounds = opts.maxRounds ?? 2;
  const all = reviewableBlocks(doc)
    .map((block) => ({ req: /\b[A-Z]{1,6}-\d{1,4}\b/.exec(block)?.[0] ?? "", block }))
    .filter((b) => b.req);
  const due = all.filter((b) => memory.needsReading(b.req, b.block, maxRounds));
  const batches: typeof due[] = [];
  for (let i = 0; i < due.length; i += size) batches.push(due.slice(i, i + size));

  const normalized = norm(sourcesBlock(sources));
  const findings: ReviewReport["findings"] = [];
  const missing: string[] = [];
  let droppedClaims = 0;
  /** Records what came back; returns the requirements it did not answer for. */
  const handle = (batch: typeof due, verdicts: ReviewVerdict[]): typeof due => {
    const by = new Map(coerceVerdicts(verdicts).map((v) => [v.req.trim().toUpperCase(), v]));
    const unanswered: typeof due = [];
    for (const b of batch) {
      const v = by.get(b.req.toUpperCase());
      if (!v) { unanswered.push(b); continue; }
      const { kept, dropped } = verifiedIssues(v.issues ?? [], sources, normalized);
      droppedClaims += dropped;
      const verdict = kept.length ? (v.verdict === "fail" ? "fail" : "minor") : "pass";
      memory.record(b.req, b.block, verdict, kept);
      if (kept.length) findings.push({ req: b.req, verdict: verdict as "minor" | "fail", issues: kept });
    }
    return unanswered;
  };
  // A batch the model answered badly (a live run returned text instead of the list, twice in four runs) is asked once more,
  // for the requirements it left out; what is still unanswered is named, never assumed fine.
  const readBatch = async (batch: typeof due) => {
    const left = handle(batch, await ask(batch));
    if (left.length) for (const b of handle(left, await ask(left))) missing.push(b.req);
  };
  if (batches.length && opts.firstAlone === false) {
    await pool(batches, opts.concurrency ?? 3, readBatch);
  } else if (batches.length) {
    await readBatch(batches[0]);
    await pool(batches.slice(1), opts.concurrency ?? 3, readBatch);
  }
  findings.sort((a, b) => (a.verdict === b.verdict ? a.req.localeCompare(b.req, undefined, { numeric: true }) : a.verdict === "fail" ? -1 : 1));
  return { read: due.length - missing.length, total: all.length, findings, stillOpen: memory.stillOpen(all).filter((r) => !findings.some((f) => f.req === r)), droppedClaims, missing };
}

// --- what the writer is told ---------------------------------------------------------------------------------

export function formatReview(r: ReviewReport, sectionOf: (req: string) => string = () => "", max = 25): string | null {
  if (!r.findings.length && !r.stillOpen.length) return null;
  const fails = r.findings.filter((f) => f.verdict === "fail").length;
  const lines: string[] = [];
  for (const f of r.findings.slice(0, max)) {
    const sec = sectionOf(f.req);
    lines.push(`**${f.req}**${sec ? ` (section “${sec}”)` : ""} — ${f.verdict}`);
    for (const i of f.issues) {
      lines.push(`- ${i.field}: ${i.problem}` + (i.source_wording ? `\n  Source: “${i.source_wording.replace(/\s+/g, " ").slice(0, 300)}”` : "") + (i.fix ? `\n  Fix: ${i.fix.replace(/\s+/g, " ").slice(0, 400)}` : ""));
    }
  }
  return (
    // Said as what happened: "checked 0 of 26" read as a reviewer that did nothing, when all 26 had been read in an
    // earlier round and were unchanged.
    `⚠ **Independent review — a second reader, who did not write these, read ${r.read} new or changed requirement${r.read === 1 ? "" : "s"} of ${r.total}` +
    `${r.total > r.read ? ` (the other ${r.total - r.read} were read in an earlier round and have not changed)` : ""}` +
    ` and found problems in ${r.findings.length}` +
    `${fails ? ` (${fails} failing)` : ""}:**\n\n${lines.join("\n")}` +
    (r.findings.length > max ? `\n\n…and ${r.findings.length - max} more.` : "") +
    (r.stillOpen.length ? `\n\nReported earlier and not yet changed: ${r.stillOpen.join(", ")}.` : "") +
    `\n\nApply each fix with patch_section (the exact text to change); one call can carry the edits of several sections (\`sections\`), so batch them. Fix "fail" findings first. If you believe a finding is wrong, leave that requirement as it is and say why in your final answer; do not rewrite whole sections for this.`
  );
}
