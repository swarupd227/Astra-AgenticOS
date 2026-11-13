/**
 * Scoring for evaluation runs — pure functions, so the rules can be tested without a model.
 *
 * A run is one agent answering one fixed case. The same prompt gave a 65K-character BRD
 * on one run and a 138K one on another, so a single run proves little: the runner repeats
 * each case, and what is compared against the baseline is the worst run, not the best.
 *
 * Two kinds of metric. HARD ones are properties the platform promises — the requested
 * sections exist, a forbidden construct is absent, a term found in no source is not
 * invented — and any miss fails. SOFT ones are quantities that drift (length, how often
 * a citation misses) and fail only when they move past a tolerance from the baseline.
 */
import {
  citationIssues, citationKey, constructsProhibitedBy, prohibitedUsed, templateDeviations, unaddressedConflicts,
} from "../src/source-checks.js";

export type EvalCase = {
  id: string;
  description: string;
  agent: string;
  saveAs: string;
  inputs: string[];
  sections: string[];
  conflictTerms: string[];
  /** Each gap lists alternative wordings; recorded when any appears. */
  gaps: string[][];
  facts: string[];
  decoys: string[];
};

export type RunEvidence = {
  artifact: string;
  /** Text of each input document, keyed by its path in the project (inputs/<file>). */
  inputTexts: Record<string, string>;
  task: string;
  /** read_artifact calls made, in order. */
  reads: { name: string; maxChars: number | null }[];
  toolCalls: number;
  seconds: number;
};

export type Metrics = {
  sectionsInOrder: boolean;
  prohibitedConstructs: number;
  decoysInvented: number;
  conflictsRecorded: number;       // of case.conflictTerms
  gapsRecorded: number;            // of case.gaps
  factsPresent: number;            // of case.facts
  inputsReadInFull: number;        // of case.inputs
  citationsChecked: number;
  citationMissRate: number;        // not-found / checked; 0 when nothing was checked
  characters: number;
  toolCalls: number;
  seconds: number;
};

/** Hyphens and spacing vary ("28 Day", "28-Day"); compare without them. */
const norm = (s: string) => s.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");

/** Whole-word match, so a decoy like "SLA" is not found inside an ordinary word. */
const hasWord = (text: string, term: string) =>
  new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(text);

export function scoreRun(c: EvalCase, e: RunEvidence): Metrics {
  const art = e.artifact;
  const lower = norm(art);

  const dev = templateDeviations(c.sections.map((s) => `## ${s}`).join("\n"), art);
  const sectionsInOrder = !!dev && dev.missing.length === 0 && !dev.outOfOrder;

  const prohibited = prohibitedUsed(art, constructsProhibitedBy(e.task)).reduce((n, r) => n + r.count, 0);

  const decoysInvented = c.decoys.filter((d) => hasWord(lower, norm(d))).length;

  const unaddressed = unaddressedConflicts(art, c.conflictTerms.map((term) => ({ term, versions: [] })));
  const conflictsRecorded = c.conflictTerms.length - unaddressed.length;

  const gapsRecorded = c.gaps.filter((alts) => alts.some((g) => lower.includes(norm(g)))).length;
  const factsPresent = c.facts.filter((f) => lower.includes(norm(f))).length;

  // Full means maxChars 0 (or a value at least as long as the document).
  const inputsReadInFull = c.inputs.filter((p) => {
    const need = e.inputTexts[p]?.length ?? Infinity;
    return e.reads.some((r) => r.name === p && (r.maxChars === 0 || (r.maxChars ?? 0) >= need));
  }).length;

  const sources = new Map(Object.entries(e.inputTexts).map(([k, v]) => [citationKey(k), v]));
  const cit = citationIssues(art, sources, new Map([["task prompt", e.task]]));
  const missed = cit.issues.filter((i) => i.kind === "not-found").length;

  return {
    sectionsInOrder, prohibitedConstructs: prohibited, decoysInvented, conflictsRecorded, gapsRecorded, factsPresent,
    inputsReadInFull, citationsChecked: cit.checked, citationMissRate: cit.checked ? +(missed / cit.checked).toFixed(3) : 0,
    characters: art.length, toolCalls: e.toolCalls, seconds: e.seconds,
  };
}

export type Verdict = { metric: string; ok: boolean; detail: string };

/** Hard properties — judged against the case itself, no baseline needed. */
export function hardChecks(c: EvalCase, m: Metrics): Verdict[] {
  const v = (metric: string, ok: boolean, detail: string): Verdict => ({ metric, ok, detail });
  return [
    v("sections present and in order", m.sectionsInOrder, m.sectionsInOrder ? "as requested" : "a requested section is missing or out of order"),
    v("forbidden constructs", m.prohibitedConstructs === 0, `${m.prohibitedConstructs} found`),
    v("invented terms", m.decoysInvented === 0, `${m.decoysInvented} of ${c.decoys.length} decoys present`),
    v("source conflict recorded", m.conflictsRecorded === c.conflictTerms.length, `${m.conflictsRecorded} of ${c.conflictTerms.length}`),
    v("gaps recorded", m.gapsRecorded === c.gaps.length, `${m.gapsRecorded} of ${c.gaps.length}`),
    v("inputs read in full", m.inputsReadInFull === c.inputs.length, `${m.inputsReadInFull} of ${c.inputs.length}`),
    // A citation check that found nothing to check has not passed — it has not run.
    v("citations checkable", m.citationsChecked > 0, m.citationsChecked > 0 ? `${m.citationsChecked} checked` : "no citation names a source the server can verify"),
  ];
}

export type Baseline = { case: string; recordedAt: string; runs: number; metrics: Metrics };

/** The worst of several runs on each soft metric — what a change is held to. */
export function worstOf(runs: Metrics[]): Metrics {
  const max = (f: (m: Metrics) => number) => Math.max(...runs.map(f));
  const min = (f: (m: Metrics) => number) => Math.min(...runs.map(f));
  const mean = (f: (m: Metrics) => number) => Math.round(runs.reduce((a, r) => a + f(r), 0) / runs.length);
  return {
    sectionsInOrder: runs.every((r) => r.sectionsInOrder),
    prohibitedConstructs: max((r) => r.prohibitedConstructs),
    decoysInvented: max((r) => r.decoysInvented),
    conflictsRecorded: min((r) => r.conflictsRecorded),
    gapsRecorded: min((r) => r.gapsRecorded),
    factsPresent: min((r) => r.factsPresent),
    inputsReadInFull: min((r) => r.inputsReadInFull),
    citationsChecked: min((r) => r.citationsChecked),
    citationMissRate: max((r) => r.citationMissRate),
    characters: mean((r) => r.characters),
    toolCalls: mean((r) => r.toolCalls),
    seconds: mean((r) => r.seconds),
  };
}

/**
 * Soft metrics against the baseline. Tolerances are deliberately loose: the point is to
 * catch a change that makes things clearly worse, not to chase run-to-run noise.
 */
export function compareToBaseline(now: Metrics, base: Metrics): Verdict[] {
  const v = (metric: string, ok: boolean, detail: string): Verdict => ({ metric, ok, detail });
  const out: Verdict[] = [];
  out.push(v("citation miss rate", now.citationMissRate <= base.citationMissRate + 0.15,
    `${now.citationMissRate} now vs ${base.citationMissRate} baseline (allowed +0.15)`));
  out.push(v("facts present", now.factsPresent >= base.factsPresent, `${now.factsPresent} now vs ${base.factsPresent} baseline`));
  const lo = Math.round(base.characters * 0.4), hi = Math.round(base.characters * 2.5);
  out.push(v("length", now.characters >= lo && now.characters <= hi, `${now.characters} chars; baseline ${base.characters} (allowed ${lo}-${hi})`));
  return out;
}
