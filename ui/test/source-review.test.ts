/**
 * Pins the orchestration and guards in src/source-review.ts. The reviewing model is replaced by a function, so
 * what is tested is what the server does with its answers: which requirements are read, when again, which
 * claims are believed, and what the writer is told.
 *
 *   npm test
 */
import { ReviewMemory, coerceReview, coerceVerdicts, formatReview, quoteInSources, reviewDocument, verifiedIssues, batchPrompt, sourcesBlock, type AskReviewer, type ReviewVerdict, type SourceText } from "../src/source-review.js";

let failures = 0;
const fail = (m: string) => { console.error(m); failures++; };
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

const SOURCES: SourceText[] = [
  { name: "inputs/req.md", text: "# Billing\n\n- The system should verify: Equipment availability, Configuration availability, Date availability before reservation confirmation.\n\nQuote may convert to: Reservation, Agreement. Pricing must flow forward consistently." },
  { name: "task prompt", text: "Delivery may capture: Proof of Delivery." },
];

const req = (n: number, statement = "The system should verify equipment availability.") =>
  `#### REQ-00${n} — Title ${n}\n\n**Requirement Statement:** ${statement}\n\n**Source Reference:** \`inputs/req.md\` — Billing.\n\n**Priority:** Not specified in source.\n\n**Dependencies:** Not specified in source.\n\n**Open Questions:** None.\n\n---\n\n`;
const docOf = (n: number, edit?: (i: number) => string) => `## 4. Requirements\n\n${Array.from({ length: n }, (_, i) => (edit ? edit(i + 1) : req(i + 1))).join("")}`;

// --- quoted source wording must be in the sources ---------------------------------------------
{
  const norm = sourcesBlock(SOURCES).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  eq("a quote in the sources is found, whatever the markdown and punctuation", quoteInSources("The system should verify:  Equipment availability, Configuration availability", norm), true);
  eq("an ellipsis skips a stretch", quoteInSources("The system should verify … before reservation confirmation", norm), true);
  eq("a quote that is not there is not found", quoteInSources("The system shall verify availability within 24 hours of the request", norm), false);
  eq("a quote too short to mean anything is not accepted", quoteInSources("shall", norm), false);

  const v = verifiedIssues([
    { kind: "strength", field: "Requirement Statement", problem: "shall for should", source_wording: "The system should verify: Equipment availability" },
    { kind: "strength", field: "Requirement Statement", problem: "made up", source_wording: "The system must reject any reservation after 5pm" },
    { kind: "citation", field: "Source Reference", problem: "no quote given" },
    { kind: "invented", field: "Requirement Statement", problem: "no source states this condition" },
    { kind: "dependency", field: "Dependencies", problem: "says not specified then lists one" },
    { kind: "name", field: "Requirement Name", problem: "" , source_wording: "Quote may convert to" },
  ], SOURCES);
  eq("a finding with a real quote is kept", v.kept.some((i) => i.problem === "shall for should"), true);
  eq("a finding whose quote is invented is dropped", v.kept.some((i) => i.problem === "made up"), false);
  eq("a finding that needs a quote and has none is dropped", v.kept.some((i) => i.problem === "no quote given"), false);
  eq("an absence needs no quote", v.kept.map((i) => i.kind).filter((k) => k === "invented" || k === "dependency").length, 2);
  eq("an empty problem is dropped", v.kept.some((i) => i.kind === "name"), false);
  eq("dropped claims are counted", v.dropped, 3);
}

// --- whatever shape the model's answer comes back in ----------------------------------------------
{
  const one = [{ req: "REQ-001", verdict: "pass", issues: [] }];
  eq("an array is taken as it is", coerceVerdicts(one).length, 1);
  eq("JSON text of an array is parsed (a live run returned a string)", coerceVerdicts(JSON.stringify(one)).length, 1);
  eq("text that is not JSON is nothing, not a crash", coerceVerdicts("sorry, here you go"), []);
  eq("an object that is not an array is nothing", coerceVerdicts({ req: "REQ-001" }), []);
  eq("entries without an ID are dropped, missing issues become none", coerceVerdicts([{ verdict: "pass" }, { req: "REQ-002", verdict: "pass" }]).map((v) => `${v.req}:${v.issues.length}`), ["REQ-002:0"]);
}

// --- the reviewer returns the problems and the IDs that passed --------------------------------------
{
  const answer = { results: [{ req: "REQ-002", verdict: "fail", issues: [{ kind: "invented", field: "Requirement Statement", problem: "x" }] }], passed: ["REQ-001", "REQ-003"] };
  eq("findings plus a pass for each ID listed as passing", coerceReview(answer).map((v) => `${v.req}:${v.verdict}`), ["REQ-002:fail", "REQ-001:pass", "REQ-003:pass"]);
  eq("an ID in both lists is a finding, not a pass", coerceReview({ results: answer.results, passed: ["REQ-002", "REQ-005"] }).map((v) => `${v.req}:${v.verdict}`), ["REQ-002:fail", "REQ-005:pass"]);
  eq("passed as JSON text, or as a comma list, is read", [coerceReview({ results: [], passed: '["REQ-001","REQ-002"]' }).length, coerceReview({ results: [], passed: "REQ-001, REQ-002; REQ-003" }).length], [2, 3]);
  eq("things that are not IDs are ignored", coerceReview({ results: [], passed: ["REQ-001", "all the rest", 7, ""] }).map((v) => v.req), ["REQ-001"]);
  eq("nothing usable is nothing, not a crash", [coerceReview(undefined).length, coerceReview("text").length, coerceReview({}).length], [0, 0, 0]);
}

// --- which requirements are read, in what batches ------------------------------------------------
const verdictFor = (b: { req: string }, issue = false): ReviewVerdict =>
  issue
    ? { req: b.req, verdict: "minor", issues: [{ kind: "strength", field: "Requirement Statement", problem: "shall for should", source_wording: "The system should verify: Equipment availability", fix: "The system should verify equipment availability." }] }
    : { req: b.req, verdict: "pass", issues: [] };

(async () => {
  {
    const calls: string[][] = [];
    const ask: AskReviewer = async (batch) => { calls.push(batch.map((b) => b.req)); return batch.map((b) => verdictFor(b, b.req === "REQ-003")); };
    const memory = new ReviewMemory();
    const r = await reviewDocument({ doc: docOf(5), sources: SOURCES, memory, ask, batchSize: 2 });
    eq("five requirements in batches of two are three calls", calls, [["REQ-001", "REQ-002"], ["REQ-003", "REQ-004"], ["REQ-005"]]);
    eq("all were read", [r.read, r.total], [5, 5]);
    eq("the one with a verified problem is reported", r.findings.map((f) => `${f.req} ${f.verdict}`), ["REQ-003 minor"]);
    eq("what was read is not read again if unchanged", (await reviewDocument({ doc: docOf(5), sources: SOURCES, memory, ask, batchSize: 2 })).read, 0);
    eq("and no further call is made", calls.length, 3);
    eq("a finding on text that has not changed is listed as still open", (await reviewDocument({ doc: docOf(5), sources: SOURCES, memory, ask, batchSize: 2 })).stillOpen, ["REQ-003"]);
  }
  {
    const seen: string[][] = [];
    const ask: AskReviewer = async (batch) => { seen.push(batch.map((b) => b.req)); return batch.map((b) => verdictFor(b, true)); };
    const memory = new ReviewMemory();
    await reviewDocument({ doc: docOf(5), sources: SOURCES, memory, ask });
    const edited = (i: number) => (i === 2 ? req(2, "The system should verify equipment availability before confirmation.") : req(i));
    const again = await reviewDocument({ doc: docOf(5, edited), sources: SOURCES, memory, ask });
    eq("only the requirement whose text changed is read again", seen[1], ["REQ-002"]);
    eq("an unchanged one with an open finding is listed, a changed one reported anew", [again.findings.map((f) => f.req), again.stillOpen.length], [["REQ-002"], 4]);
    // A third round: REQ-002 has been read twice and is not read a third time, however often it changes.
    const third = await reviewDocument({ doc: docOf(5, (i) => (i === 2 ? req(2, "Another wording of the statement for this requirement.") : req(i))), sources: SOURCES, memory, ask, maxRounds: 2 });
    eq("a requirement is read at most twice", third.read, 0);
  }
  {
    // A bad answer is asked about once more, for what it left out.
    let n = 0; const asked: string[][] = [];
    const flaky: AskReviewer = async (batch) => { asked.push(batch.map((b) => b.req)); return n++ === 0 ? [] : batch.map((b) => verdictFor(b)); };
    const r = await reviewDocument({ doc: docOf(5), sources: SOURCES, memory: new ReviewMemory(), ask: flaky, batchSize: 5 });
    eq("an empty answer is retried for the same requirements", asked, [["REQ-001", "REQ-002", "REQ-003", "REQ-004", "REQ-005"], ["REQ-001", "REQ-002", "REQ-003", "REQ-004", "REQ-005"]]);
    eq("and once answered they are read, not missing", [r.read, r.missing.length], [5, 0]);
    const never: AskReviewer = async () => [];
    const r2 = await reviewDocument({ doc: docOf(5), sources: SOURCES, memory: new ReviewMemory(), ask: never, batchSize: 5 });
    eq("a second empty answer leaves them missing, and the call is not repeated forever", [r2.read, r2.missing.length], [0, 5]);
  }
  {
    const ask: AskReviewer = async (batch) => batch.slice(0, 1).map((b) => verdictFor(b));
    const r = await reviewDocument({ doc: docOf(5), sources: SOURCES, memory: new ReviewMemory(), ask, batchSize: 5 });
    eq("requirements the reviewer keeps leaving out are named, not assumed fine", r.missing, ["REQ-003", "REQ-004", "REQ-005"]);
    eq("and are not counted as read (the retry answered for one more)", r.read, 2);
  }
  {
    const ask: AskReviewer = async (batch) => batch.map((b) => ({ req: b.req, verdict: "fail", issues: [{ kind: "strength", field: "Requirement Statement", problem: "invented", source_wording: "The system must refuse every request" }] }));
    const r = await reviewDocument({ doc: docOf(5), sources: SOURCES, memory: new ReviewMemory(), ask });
    eq("a verdict of fail resting only on an invented quote is not believed", [r.findings.length, r.droppedClaims], [0, 5]);
  }

  // --- what the writer is told ---------------------------------------------------------------------
  {
    const ask: AskReviewer = async (batch) => batch.map((b) => verdictFor(b, true));
    const r = await reviewDocument({ doc: docOf(5), sources: SOURCES, memory: new ReviewMemory(), ask });
    const text = formatReview(r, (id) => (id === "REQ-001" ? "4. Requirements" : "")) ?? "";
    eq("it names the requirement, its section, the problem, the source and the fix", [/REQ-001\*\* \(section “4\. Requirements”\)/.test(text), /shall for should/.test(text), /Source: “The system should verify/.test(text), /Fix: The system should verify equipment availability\./.test(text)], [true, true, true, true]);
    eq("it tells the writer to patch, not rewrite", /patch_section/.test(text) && /do not rewrite whole sections/.test(text), true);
    eq("nothing is said when there is nothing", formatReview({ read: 3, total: 3, findings: [], stillOpen: [], droppedClaims: 0, missing: [] }), null);
  }
  eq("the batch prompt carries every requirement by its ID", /Requirement 2: REQ-002/.test(batchPrompt([{ req: "REQ-001", block: "a" }, { req: "REQ-002", block: "b" }])), true);

  console.log(`independent review — ${failures} failure(s)`);
  process.exit(failures ? 1 : 0);
})();
