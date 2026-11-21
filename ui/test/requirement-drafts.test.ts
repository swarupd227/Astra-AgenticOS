/**
 * Pins src/requirement-drafts.ts: which source text an area is given, how the areas' requirement IDs become one
 * sequence, and the draft → check → review → fix loop, with the model calls replaced by functions.
 *
 *   npm test
 */
import { areaHeadings, carryReview, cleanArea, definedIds, draftArea, extractSection, mergeChanges, renumber, type Area, type WriteCall } from "../src/requirement-drafts.js";
import { ReviewMemory, type ReviewReport } from "../src/source-review.js";

let failures = 0;
const fail = (m: string) => { console.error(m); failures++; };
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

const DR = [
  "# **Credit Management and Collections**", "", "## **Credit Limit Allocation**", "", "### **Requirement Overview**", "Credit checks should occur during Quote Creation.",
  "### **Information Missing / Requirement Gaps**", "#### **Gap 1: Credit Limit Ownership**", "Who owns it?",
  "# **Post Billing / Pre Billing**", "", "## **Billing Methods**", "", "### **Requirement Overview**", "Billing Method is selected during Agreement creation.",
  "#### **Gap 1: Ownership of Billing Method**", "Where do preferences originate?",
].join("\n");
const SOURCES = [
  { name: "task prompt", text: "BILLING METHODS\nBilling Method is selected during Agreement creation." },
  { name: "inputs/Detailed-Requirements-1.md", text: DR },
  { name: "inputs/Business-Operations-Flow.md", text: "**Phase 2 - Quote**\nNo headings here." },
];

// --- the sources by heading -------------------------------------------------------------------------
eq("the areas are the second-level headings, without markup", areaHeadings(SOURCES).map((a) => a.title), ["Credit Limit Allocation", "Billing Methods"]);
{
  const e = extractSection(SOURCES, "Billing Methods");
  eq("an area's section runs to the next heading of its level or above", [e?.title, e?.text.includes("Ownership of Billing Method"), e?.text.includes("Credit")], ["Billing Methods", true, false]);
  const c = extractSection(SOURCES, "inputs/Detailed-Requirements-1.md — Credit Limit Allocation");
  eq("a heading given with its file name is found, and stops before the next area", [c?.title, c?.text.includes("Gap 1: Credit Limit Ownership"), c?.text.includes("Billing")], ["Credit Limit Allocation", true, false]);
  eq("a heading that is not there is not found", extractSection(SOURCES, "Insurance Master"), null);
  eq("the exact heading wins over one that contains it", extractSection(SOURCES, "Requirement Overview")?.text.includes("Credit checks"), true);
  // A live input put "# Our Understanding" and "# Information Missing" at the top level inside an area.
  const odd = [{ name: "inputs/x.md", text: "# **Personalization**\n## **List Screen Personalization**\nIntro.\n# **Our Understanding**\nUsers should sort.\n# **Information Missing / Requirement Gaps**\n#### Gap 1: Limits\n\n# **Personalization**\n## **Detail Screen Personalization**\nOther." }];
  const l = extractSection(odd, "List Screen Personalization");
  eq("an area runs to the next area heading, over top-level headings inside it, without the next area's category line", [l?.text.includes("Gap 1: Limits"), l?.text.includes("Detail Screen"), /Personalization\*\*\s*$/.test(l?.text ?? "")], [true, false, false]);
}

// --- one writer per source area ------------------------------------------------------------------------------
{
  const { splitAreas } = await import("../src/requirement-drafts.js");
  const ex = (title: string) => ({ source: "inputs/x.md", title, text: `## ${title}\n…` });
  const areas = [
    { section: "6.1 Billing", scope: "Billing", sourceHeadings: ["Billing Methods"] },
    { section: "6.12 Personalization", scope: "List Screen, Detail Screen, Conditional Validation", sourceHeadings: ["Personalization", "List Screen Personalization", "Detail Screen Personalization", "Conditional Validation"] },
    { section: "6.13 Forms", scope: "Forms", sourceHeadings: [] },
  ];
  const r = splitAreas(areas, [[ex("Billing Methods")], [ex("Personalization"), ex("List Screen Personalization"), ex("Detail Screen Personalization"), ex("Conditional Validation")], []],
    [{ title: "Billing Methods" }, { title: "List Screen Personalization" }, { title: "Detail Screen Personalization" }, { title: "Conditional Validation" }]);
  eq("an area given several source areas becomes one per source area, sub-numbered, the category heading dropped",
    r.areas.map((a) => a.section), ["6.1 Billing", "6.12.1 Personalization — List Screen Personalization", "6.12.2 Personalization — Detail Screen Personalization", "6.12.3 Personalization — Conditional Validation", "6.13 Forms"]);
  eq("each part gets its own section and is told it is one part", [r.extracts[2].map((e) => e.title), /one part of "6.12 Personalization"/.test(r.areas[2].scope), r.split], [["Detail Screen Personalization"], true, ["6.12 Personalization"]]);
}

// --- the writer's output -----------------------------------------------------------------------------------
const area: Area = { section: "6.2 Billing Methods", scope: "Billing Methods", sourceHeadings: ["Billing Methods"] };
eq("a preamble and code fence are dropped", cleanArea("Here is the area:\n```markdown\n### 6.2 Billing Methods\n\n#### REQ-001 — A\n```", area), "### 6.2 Billing Methods\n\n#### REQ-001 — A");
eq("a missing heading is supplied", cleanArea("#### REQ-001 — A", area).startsWith("#### REQ-001"), true);
eq("text with no heading at all gets the area's", cleanArea("Nothing here.", area), "### 6.2 Billing Methods\n\nNothing here.");

{
  const a = "### A\n\n#### REQ-001 — One\n\n**Dependencies:** REQ-002 — “x”\n\n#### REQ-002 — Two\n";
  const b = "### B\n\n#### REQ-001 — Three\n\nSee the Billing area, not REQ-009.\n";
  const r = renumber([a, b]);
  eq("IDs run on across areas", r.texts.map(definedIds), [["REQ-001", "REQ-002"], ["REQ-003"]]);
  eq("a mention of the area's own ID follows it", r.texts[0].includes("**Dependencies:** REQ-002"), true);
  eq("a mention of an ID the area does not define is left alone", r.texts[1].includes("REQ-009"), true);
  eq("the ranges are reported", r.ranges, [{ first: "REQ-001", last: "REQ-002", count: 2 }, { first: "REQ-003", last: "REQ-003", count: 1 }]);
  eq("an area with none is an empty range", renumber(["### C\n\nNo requirements."]).ranges, [{ first: "", last: "", count: 0 }]);
}

// --- a fix that returns only its changes ----------------------------------------------------------------------
{
  const area3 = "### 6.1 Billing\n\n**Feature analysis**\n\n| Aspect | From the sources |\n|---|---|\n| Trigger | old |\n\n---\n\n#### REQ-001 — A\n\n**Requirement Statement:** one.\n\n---\n\n#### REQ-002 — B\n\n**Requirement Statement:** two.\n\n---\n\n#### REQ-003 — C\n\n**Requirement Statement:** three.\n";
  const m = mergeChanges(area3, "Here are the changes:\n\n#### REQ-002 — B\n\n**Requirement Statement:** two, corrected.\n\n#### REQ-003 — C\n\nDELETE\n\n#### REQ-004 — D\n\n**Requirement Statement:** four.")!;
  eq("a returned requirement replaces its own, DELETE removes one, a new one is added, the rest stay", definedIds(m), ["REQ-001", "REQ-002", "REQ-004"]);
  eq("the changed text is in, the area heading and Feature analysis kept", [m.includes("two, corrected"), m.includes("one."), m.startsWith("### 6.1 Billing"), m.includes("| Trigger | old |")], [true, true, true, true]);
  const f = mergeChanges(area3, "**Feature analysis**\n\n| Aspect | From the sources |\n|---|---|\n| Trigger | new |")!;
  eq("a returned Feature analysis replaces the area's, under the same heading", [f.startsWith("### 6.1 Billing"), f.includes("| Trigger | new |"), f.includes("| Trigger | old |"), definedIds(f).length], [true, true, false, 3]);
  eq("an answer with nothing usable is not a merge", mergeChanges(area3, "I agree with the findings."), null);
  eq("DELETE in markup or with punctuation still deletes", ["**DELETE**", "DELETE.", "_Delete_"].map((d) => definedIds(mergeChanges(area3, `#### REQ-003 — C\n\n${d}`)!)), [["REQ-001", "REQ-002"], ["REQ-001", "REQ-002"], ["REQ-001", "REQ-002"]]);
}

// --- a fix at check_document, after the IDs are global -------------------------------------------------------
{
  const { renumberNewIds } = await import("../src/requirement-drafts.js");
  const { destructiveSave, countCitations, countIds } = await import("../src/guards.js");
  // Area B holds REQ-040..REQ-041; area C starts at REQ-042. B's writer adds "the next unused ID", REQ-042.
  const before = "### 6.2 B\n\n#### REQ-040 — x\n\nSee REQ-041.\n\n#### REQ-041 — y\n";
  const fixed = before + "\n#### REQ-042 — new item\n\nRelated to REQ-042 itself and REQ-040.\n";
  const r = renumberNewIds(fixed, ["REQ-040", "REQ-041"], ["REQ-001", "REQ-042", "REQ-043"], 44);
  eq("a new ID another area defines is moved past every ID in use, everywhere in the section", [[...r.moved.entries()], definedIds(r.text), /REQ-042/.test(r.text), r.next], [[["REQ-042", "REQ-044"]], ["REQ-040", "REQ-041", "REQ-044"], false, 45]);
  eq("the section's own IDs and its references to them are left alone", /See REQ-041\./.test(r.text) && /REQ-040\.\n$/.test(r.text), true);
  const free = renumberNewIds(before + "\n#### REQ-050 — new\n", ["REQ-040", "REQ-041"], ["REQ-042"], 44);
  eq("a new ID no one else uses is kept", [free.moved.size, free.next], [0, 44]);
  // The guard a fixed section passes before it replaces the old text.
  const longArea = Array.from({ length: 12 }, (_, i) => `#### REQ-0${10 + i} — item\n\n**Source Reference:** \`inputs/x.md\` — Area: “a sentence quoted from the source number ${i}”\n`).join("\n");
  const guard = (next: string) => destructiveSave({ kind: "section", newLen: next.length, prevLen: longArea.length, name: "doc § area", prevCitations: countCitations(longArea), newCitations: countCitations(next), prevIds: countIds(longArea), newIds: countIds(next) });
  eq("a fix that shrinks the section and drops its citations is refused; an equal-size fix is not", [guard(longArea.slice(0, 200)) !== null, guard(longArea.replace("number 3", "number three")) === null], [true, true]);
}

// --- one area, start to finish -------------------------------------------------------------------------------
const reqBlock = (id: string, statement: string) => `#### ${id} — Billing Method Selection\n\n**Requirement Statement:** ${statement}\n\n**Source Reference:** \`inputs/Detailed-Requirements-1.md\` — Billing Methods.\n\n**Priority:** Not specified in source.\n\n**Dependencies:** Not Specified.\n\n**Open Questions:** None identified in source.\n`;
const draft = `### 6.2 Billing Methods\n\n${reqBlock("REQ-001", "Billing Method shall be selected during Agreement creation.")}\n${reqBlock("REQ-002", "Invoices are generated according to the schedule.")}`;
const fixed = draft.replace("shall be selected", "is selected");

(async () => {
  {
    const calls: number[] = [];
    const write: WriteCall = async (m) => { calls.push(m.length); return m.length === 1 ? draft : fixed; };
    const review = async (text: string, memory: ReviewMemory): Promise<ReviewReport> => {
      const { requirementBlocks } = await import("../src/source-checks.js");
      const blocks = requirementBlocks(text).map((b) => ({ req: /REQ-\d+/.exec(b)![0], block: b }));
      const due = blocks.filter((b) => memory.needsReading(b.req, b.block, 2));
      const findings: ReviewReport["findings"] = [];
      for (const b of due) {
        const bad = /shall be selected/.test(b.block);
        memory.record(b.req, b.block, bad ? "fail" : "pass", bad ? [{ kind: "strength", field: "Requirement Statement", problem: "shall for is" }] : []);
        if (bad) findings.push({ req: b.req, verdict: "fail", issues: [{ kind: "strength", field: "Requirement Statement", problem: "shall for is" }] });
      }
      return { read: due.length, total: blocks.length, findings, stillOpen: memory.stillOpen(blocks).filter((r) => !findings.some((f) => f.req === r)), droppedClaims: 0, missing: [] };
    };
    const memory = new ReviewMemory();
    const r = await draftArea({ area, extracts: [], write, check: () => [], review, memory, rounds: 2 });
    eq("a draft, a fix after the first review, and a second review that finds nothing", [calls, r.fixRounds, r.openReview.length], [[1, 3], 1, 0]);
    eq("the fixed text is kept", r.text.includes("is selected") && !r.text.includes("shall be selected"), true);
    eq("its requirements are counted", r.reqs, 2);

    // What the area's reviewer read is carried into the run's memory under the new IDs, so it is not read again.
    const { texts } = renumber(["### 6.1 Other\n\n" + reqBlock("REQ-001", "Something else."), r.text]);
    const run = new ReviewMemory();
    carryReview(r.text, texts[1], memory, run);
    const { requirementBlocks } = await import("../src/source-checks.js");
    const blocks = requirementBlocks(texts[1]);
    eq("the renumbered requirements count as read", blocks.map((b) => run.needsReading(/REQ-\d+/.exec(b)![0], b, 2)), [false, false]);
  }
  {
    // A fix returns only what changes: leaving a requirement out keeps it; deleting one no finding named is refused.
    const review = async (text: string, memory: ReviewMemory): Promise<ReviewReport> => {
      memory.record("REQ-001", text, "fail", [{ kind: "strength", field: "Requirement Statement", problem: "x" }]);
      return { read: 2, total: 2, findings: [{ req: "REQ-001", verdict: "fail", issues: [{ kind: "strength", field: "Requirement Statement", problem: "x" }] }], stillOpen: [], droppedClaims: 0, missing: [] };
    };
    const onlyOne: WriteCall = async (m) => (m.length === 1 ? draft : reqBlock("REQ-001", "Billing Method is selected during Agreement creation."));
    const kept = await draftArea({ area, extracts: [], write: onlyOne, check: () => [], review, memory: new ReviewMemory(), rounds: 1 });
    eq("a requirement the fix leaves out is kept, and the one it returns replaces its own", [kept.reqs, kept.text.includes("is selected during"), kept.text.includes("Invoices are generated")], [2, true, true]);
    const deletes: WriteCall = async (m) => (m.length === 1 ? draft : "#### REQ-002 — Billing Method Selection\n\nDELETE");
    const r = await draftArea({ area, extracts: [], write: deletes, check: () => [], review, memory: new ReviewMemory(), rounds: 2 });
    eq("deleting a requirement no finding named is refused, the draft kept and its finding left open", [r.reqs, r.openReview.map((o) => o.req), /dropped REQ-002/.test(r.note ?? "")], [2, ["REQ-001"], true]);
  }
  {
    // A fix that removes the requirement a finding named (invented, a duplicate) is what was asked for.
    const write: WriteCall = async (m) => (m.length === 1 ? draft : `#### REQ-002 — Billing Method Selection\n\nDELETE`);
    const review = async (_t: string, _m: ReviewMemory): Promise<ReviewReport> =>
      ({ read: 2, total: 2, findings: [{ req: "REQ-002", verdict: "fail", issues: [{ kind: "invented", field: "Requirement Statement", problem: "no source states this" }] }], stillOpen: [], droppedClaims: 0, missing: [] });
    const r = await draftArea({ area, extracts: [], write, check: () => [], review, memory: new ReviewMemory(), rounds: 1 });
    eq("a fix may remove a requirement a finding named", [r.reqs, /removed REQ-002/.test(r.note ?? "")], [1, true]);
  }
  {
    // A reviewer that answers for nothing (an outage, or a reply with no tool call) leaves the area NOT reviewed, not clean.
    const { summarizeDrafts } = await import("../src/requirement-drafts.js");
    const write: WriteCall = async () => draft;
    const silent = async (text: string): Promise<ReviewReport> => {
      const { requirementBlocks } = await import("../src/source-checks.js");
      const ids = requirementBlocks(text).map((b) => /REQ-\d+/.exec(b)![0]);
      return { read: 0, total: ids.length, findings: [], stillOpen: [], droppedClaims: 0, missing: ids };
    };
    const r = await draftArea({ area, extracts: [], write, check: () => [], review: silent, memory: new ReviewMemory(), rounds: 2 });
    eq("requirements the reviewer never answered for are reported as unreviewed", r.unreviewed, ["REQ-001", "REQ-002"]);
    const s = summarizeDrafts([r], [{ first: "REQ-001", last: "REQ-002", count: 2 }], 1000);
    eq("and the summary says so instead of 'read by the independent reviewer'", [/NOT reviewed/.test(s), /read by the independent reviewer/.test(s)], [true, false]);
  }
  {
    // Server checks alone are enough to ask for a fix; with no review rounds nothing is asked.
    let n = 0;
    const write: WriteCall = async () => { n++; return draft; };
    const none = async (): Promise<ReviewReport> => ({ read: 0, total: 0, findings: [], stillOpen: [], droppedClaims: 0, missing: [] });
    const r = await draftArea({ area, extracts: [], write, check: (t) => (/shall/.test(t) ? ["strength"] : []), review: none, memory: new ReviewMemory(), rounds: 1 });
    eq("an open server check asks the writer for a fix", [n, r.fixRounds, r.openChecks], [2, 1, ["strength"]]);
    n = 0;
    await draftArea({ area, extracts: [], write, check: () => ["x"], review: none, memory: new ReviewMemory(), rounds: 0 });
    eq("with no rounds there is only the draft", n, 1);
  }

  {
    // A chapter: drafted, checked, corrected once when a check is open.
    const { draftChapter, headingFor, applyChapterEdits } = await import("../src/requirement-drafts.js");
    let n = 0;
    const write: WriteCall = async (m) => { n++; return m.length === 1 ? "Sure:\n### 5.2 Success Criteria\n\nThe Branch Manager reviews it." : "<<<FIND\nThe Branch Manager reviews it.\n===\n*Not specified in source.*\n>>>"; };
    const r = await draftChapter({ chapter: { section: "5.2 Success Criteria", instructions: "Follow the task's 'Success Criteria' instructions." }, write, rounds: 2, check: (t) => (/Branch Manager/.test(t) ? ["Roles that appear in none of the sources: Branch Manager"] : []) });
    eq("a chapter's open check is fixed by an edit, its preamble dropped", [n, r.fixRounds, r.openChecks.length, r.text], [2, 1, 0, "### 5.2 Success Criteria\n\n*Not specified in source.*"]);
    eq("a chapter heading is ## and a sub-section ###", [headingFor("6. Key Features"), headingFor("5.1 Business Objectives")], ["## 6. Key Features", "### 5.1 Business Objectives"]);
    const doc = "## 6. Key Features\n\nAlpha  beta gamma.\n\nRepeat. Repeat.\n\nDelta.";
    const e = applyChapterEdits(doc, "<<<FIND\nAlpha beta gamma.\n===\nAlpha.\n>>>\n<<<FIND\nRepeat.\n===\nOnce.\n>>>\n<<<FIND\nNot there.\n===\nx\n>>>\n<<<FIND\nDelta.\n===\n\n>>>");
    eq("edits apply one at a time; whitespace is tolerated; ambiguous or missing ones are skipped; an empty replacement deletes", [e.applied, e.skipped, e.text], [2, 2, "## 6. Key Features\n\nAlpha.\n\nRepeat. Repeat.\n\n"]);
    let calls = 0;
    const slow: WriteCall = async (m) => { calls++; return m.length === 1 ? "### 5.2 X\n\nThe Branch Manager reviews it." : "<<<FIND\nnothing\n===\nx\n>>>"; };
    const s = await draftChapter({ chapter: { section: "5.2 X", instructions: "i" }, write: slow, rounds: 4, budgetMs: 1, check: () => ["open"] });
    await new Promise((res) => setTimeout(res, 5));
    eq("past its time budget a chapter is not fixed again", [calls <= 2, s.openChecks.length], [true, 1]);
  }

  console.log(`requirement drafts — ${failures} failure(s)`);
  process.exit(failures ? 1 : 0);
})();
