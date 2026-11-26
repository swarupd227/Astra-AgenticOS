/**
 * Pins src/source-coverage.ts: the second reader for documents with no headings. The model is replaced by a function, so
 * what is tested is the chunking, the digest, which parts are read again, which claims are believed, and the wording.
 *
 *   npm run test:coverage
 */
import { CoverageMemory, chunksOf, formatCoverage, requirementDigest, reviewCoverage, type AskCoverage } from "../src/source-coverage.js";

let failures = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); failures++; }
};

const para = (n: number) => `Paragraph ${n} of the flow. ` + "The quote stage captures the customer, the job and the dates for the rental. ".repeat(4);
const TEXT = Array.from({ length: 10 }, (_, i) => para(i)).join("\n\n");
const RULE = "The quoted equipment requirement must also include the quantity needed.";
const WITH_RULE = `${para(1)}\n\n${RULE} Nothing else is stated here, but the paragraph is long enough to be read as a part of its own.\n\n${para(2)}`;

// --- chunks never cut a paragraph -----------------------------------------------------------------
{
  const c = chunksOf("inputs/flow.md", TEXT, 1000);
  eq("a long document is cut into parts", c.length > 1, true);
  eq("each part is whole paragraphs", c.every((x) => /^Paragraph \d+ of the flow\./.test(x.text) && x.text.endsWith("rental.")), true);
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  eq("nothing is lost", flat(c.map((x) => x.text).join(" ")), flat(TEXT));
  eq("a stub is not worth a read", chunksOf("a.md", "Short.", 1000).length, 0);
}

// --- the digest -------------------------------------------------------------------------------------
{
  const d = requirementDigest(["#### REQ-001 — Quote Capture\n\n**Requirement Statement:** The quote captures the customer.\n\n**Source Reference:** x\n"]);
  eq("a requirement is one line with its ID, name and statement", d, "REQ-001 — Quote Capture: The quote captures the customer.");
}

// --- what the reader may claim, and what is read again ----------------------------------------------
{
  const calls: string[] = [];
  const ask: AskCoverage = async (c) => {
    calls.push(c.text.slice(0, 12));
    return c.text.includes(RULE)
      ? [{ quote: RULE, why: "Obliges the quote to carry a quantity; REQ-005 comes closest but has none." }, { quote: "The quote must be signed by the customer within 30 days.", why: "Invented by the reader." }]
      : [];
  };
  const memory = new CoverageMemory();
  const docs = [{ source: "inputs/flow.md", text: WITH_RULE }];
  const r = await reviewCoverage({ documents: docs, digest: "REQ-005 — Quote: dates.", memory, ask });
  eq("a quoted statement that is in the part is reported", r.findings.map((f) => f.quote), [RULE]);
  eq("a quote that is not in the part is dropped and counted", r.droppedClaims, 1);
  eq("the report says where it came from", r.findings[0].source, "inputs/flow.md");

  const before = calls.length;
  const again = await reviewCoverage({ documents: docs, digest: "REQ-005 — Quote: dates.", memory, ask });
  eq("the same requirements are not asked about again", calls.length, before);
  eq("but the finding is still reported", again.findings.length, 1);
  await reviewCoverage({ documents: docs, digest: "REQ-005 — Quote: dates.\nREQ-006 — Quantity.", memory, ask });
  eq("a part with a finding is read again when the requirements change", calls.length > before, true);

  const clean = new CoverageMemory(); const asks: number[] = [];
  const quiet: AskCoverage = async () => { asks.push(1); return []; };
  const d2 = [{ source: "inputs/flow.md", text: TEXT }];
  await reviewCoverage({ documents: d2, digest: "a", memory: clean, ask: quiet });
  const n = asks.length;
  await reviewCoverage({ documents: d2, digest: "a — and more", memory: clean, ask: quiet });
  eq("a part that came back clean is not read again, whatever is added", asks.length, n);
}

// --- the task, which sets the scope, goes to the reader
{
  let seen = "";
  await reviewCoverage({ documents: [{ source: "a.md", text: WITH_RULE }], digest: "d", task: "Anything outside this list is out of scope.", memory: new CoverageMemory(), ask: async (_c, _d, t) => { seen = t; return []; } });
  eq("the reader is given the task", seen, "Anything outside this list is out of scope.");
}

// --- a bad answer is never read as clean ------------------------------------------------------------
{
  let n = 0;
  const flaky: AskCoverage = async () => (++n === 1 ? null : []);
  const r = await reviewCoverage({ documents: [{ source: "a.md", text: WITH_RULE }], digest: "d", memory: new CoverageMemory(), ask: flaky });
  eq("one bad answer is asked again", r.unreturned, 0);
  const dead = await reviewCoverage({ documents: [{ source: "a.md", text: WITH_RULE }], digest: "d", memory: new CoverageMemory(), ask: async () => null });
  eq("two bad answers are named", dead.unreturned, 1);
  eq("and said to the writer", /could not be read/.test(formatCoverage(dead) ?? ""), true);
}

// --- what the writer is told ------------------------------------------------------------------------
{
  eq("nothing found says nothing", formatCoverage({ chunks: 3, read: 3, findings: [], droppedClaims: 0, unreturned: 0 }), null);
  const t = formatCoverage({ chunks: 3, read: 3, findings: [{ source: "inputs/flow.md", quote: RULE, why: "Needs a requirement." }], droppedClaims: 0, unreturned: 0 }) ?? "";
  eq("a finding names the document, the sentence and why", t.includes("inputs/flow.md") && t.includes(RULE) && t.includes("Needs a requirement."), true);
}

console.log(`source coverage — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
