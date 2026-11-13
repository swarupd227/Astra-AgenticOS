/**
 * Pins the scoring rules in eval/score.ts — what counts as a pass — without a model.
 *
 *   npm test
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareToBaseline, hardChecks, scoreRun, worstOf, type EvalCase, type RunEvidence } from "../eval/score.js";

let failures = 0;
const fail = (m: string) => { console.error(m); failures++; };
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(want === got ? got : got)}`);
};

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "eval", "fixtures", "acme-brd");
const c: EvalCase = JSON.parse(fs.readFileSync(path.join(dir, "case.json"), "utf8"));
const task = fs.readFileSync(path.join(dir, "prompt.txt"), "utf8");
const inputTexts = Object.fromEntries(c.inputs.map((p) => [p, fs.readFileSync(path.join(dir, p), "utf8")]));

const GOOD = `# BRD

## Business Objectives
Control credit exposure before equipment is committed.

## Success Criteria
Quotes are checked against the credit limit.

## Requirements
REQ-001 Billing methods are Weekly, Monthly and 28 Day billing. Source: inputs/acme-process-flow.md
REQ-002 Exposure is open receivables plus unbilled rental value plus new order value. Source: inputs/acme-detailed-requirements.md
REQ-003 Source Conflict Identified: Reservation. The process flow says "A Reservation represents confirmed future demand." The requirements say "A time-bounded hold on availability that is not necessarily a confirmed contract." Not resolved.

## Open Questions
- Who approves a late-fee waiver? Not specified in source.
- Is the billing method chosen per customer or per agreement? Not specified in source.
`;

const evidence = (artifact: string, over: Partial<RunEvidence> = {}): RunEvidence => ({
  artifact, inputTexts, task, toolCalls: 7, seconds: 60,
  reads: c.inputs.map((name) => ({ name, maxChars: 0 })), ...over,
});

const m = scoreRun(c, evidence(GOOD));
const hard = hardChecks(c, m);
eq("a faithful document passes every hard check", hard.filter((h) => !h.ok).map((h) => h.metric), []);
eq("all four facts are found, hyphens ignored", m.factsPresent, 4);

const bad = (art: string, over?: Partial<RunEvidence>) => hardChecks(c, scoreRun(c, evidence(art, over))).filter((h) => !h.ok).map((h) => h.metric);

eq("a missing section fails", bad(GOOD.replace("## Success Criteria", "## Other")), ["sections present and in order"]);
eq("sections out of order fail", bad(GOOD.replace("## Business Objectives", "## Open Questions").replace(/## Open Questions\n- Who/, "## Business Objectives\n- Who")), ["sections present and in order"]);
eq("a user story fails", bad(GOOD + "\nAs a Finance user, I want to approve credit so that risk is reduced.\n"), ["forbidden constructs"]);
eq("Given/When/Then fails", bad(GOOD + "\nGiven a quote\nWhen it is created\nThen it is checked\n"), ["forbidden constructs"]);
eq("an invented billing method fails", bad(GOOD + "\nREQ-009 Daily Billing is supported.\n"), ["invented terms"]);
eq("a hyphenated invented term is still caught", bad(GOOD + "\nFour Weekly billing applies.\n"), ["invented terms"]);
eq("an invented actor fails", bad(GOOD + "\nThe Branch Manager approves exceptions.\n"), ["invented terms"]);
eq("silence about a source conflict fails",
  bad(GOOD.replace(/REQ-003[^\n]*\n/, "REQ-003 A Reservation holds equipment.\n")), ["source conflict recorded"]);
eq("a missing gap fails", bad(GOOD.replace("- Who approves a late-fee waiver? Not specified in source.\n", "")), ["gaps recorded"]);
eq("alternative wording still counts as the gap",
  bad(GOOD.replace("per customer or per agreement", "at customer level or agreement level")), []);
eq("a truncated read of an input fails 'read in full'",
  bad(GOOD, { reads: [{ name: c.inputs[0], maxChars: 0 }, { name: c.inputs[1], maxChars: 20000 > 100 ? 100 : 0 }] }), ["inputs read in full"]);
eq("a read cap larger than the document counts as full",
  bad(GOOD, { reads: c.inputs.map((name) => ({ name, maxChars: 999999 })) }), []);
eq("an unread input fails", bad(GOOD, { reads: [{ name: c.inputs[0], maxChars: 0 }] }), ["inputs read in full"]);

// Citing by an abbreviation the server cannot match means the check never ran.
eq("abbreviated citations leave nothing to check, which fails",
  bad(GOOD.replace(/Source: inputs\/acme-[a-z-]+\.md/g, "Source: PF section 2")), ["citations checkable"]);

// A citation to a source that does not contain the wording is counted.
{
  const wrong = GOOD.replace("Source: inputs/acme-process-flow.md", "Source: inputs/acme-detailed-requirements.md");
  const mm = scoreRun(c, evidence(wrong));
  if (mm.citationsChecked < 1) fail("citations should have been checked");
  if (mm.citationMissRate <= 0) fail("a misattributed citation should raise the miss rate");
}

// Baseline comparison: loose on purpose, and the worst of several runs is what is held to.
const base = worstOf([m, m]);
eq("identical metrics are within the baseline", compareToBaseline(m, base).filter((v) => !v.ok).length, 0);
eq("a much higher citation miss rate drifts", compareToBaseline({ ...m, citationMissRate: base.citationMissRate + 0.4 }, base).filter((v) => !v.ok).map((v) => v.metric), ["citation miss rate"]);
eq("losing a fact drifts", compareToBaseline({ ...m, factsPresent: base.factsPresent - 1 }, base).filter((v) => !v.ok).map((v) => v.metric), ["facts present"]);
eq("a document a fifth the length drifts", compareToBaseline({ ...m, characters: Math.round(base.characters / 5) }, base).filter((v) => !v.ok).map((v) => v.metric), ["length"]);
eq("ordinary length variation does not", compareToBaseline({ ...m, characters: Math.round(base.characters * 1.5) }, base).filter((v) => !v.ok).length, 0);
{
  const w = worstOf([{ ...m, prohibitedConstructs: 0, factsPresent: 4, citationMissRate: 0.1 }, { ...m, prohibitedConstructs: 3, factsPresent: 2, citationMissRate: 0.3 }]);
  eq("worst of runs takes the highest violations", w.prohibitedConstructs, 3);
  eq("worst of runs takes the fewest facts", w.factsPresent, 2);
  eq("worst of runs takes the highest miss rate", w.citationMissRate, 0.3);
}

console.log(`evaluation scoring — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
