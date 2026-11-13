/**
 * Pins the checks in src/source-checks.ts.
 *
 *   npm test
 *
 * Synthetic text only — the thresholds were calibrated on a real client BRD, which is
 * not committed. What matters is where each check draws its line: the shapes that must
 * be flagged, and the near-misses that must stay quiet.
 */
import {
  citationIssues, citationKey, constructsProhibitedBy, extractDefinitions, formatCitationReport,
  formatInventedRoles, inventedRoles, noCheckableCitations, prohibitedUsed, templateDeviations, termConflicts,
  unaddressedConflicts,
} from "../src/source-checks.js";

let failures = 0;
const fail = (m: string) => { console.error(m); failures++; };
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

// --- citations --------------------------------------------------------------------
const FLOW = `
The Delivery stage begins once an Agreement exists. Equipment is allocated, checked out and planned for delivery.
Delivery may capture proof of delivery including signatures, photos and meter readings.
After delivery the equipment status is updated to On Rent.
`;
const SPEC = `
Credit exposure is calculated as open receivables plus unbilled rental value plus new order value.
When exposure exceeds the credit limit the transaction is blocked or routed for approval.
Past due invoices should affect future transactions.
`;
const sources = new Map([["GLD-FS-001", FLOW], ["GLD-FS-002", SPEC]]);
const others = new Map([["task prompt", "Billing methods include 28 Day, Monthly, Calendar Month and Weekly. The billing method is selected during agreement creation."]]);

{
  const ok = citationIssues(
    "- When exposure exceeds the credit limit the transaction is blocked or routed for approval. *(GLD-FS-002@1)*", sources, others);
  eq("supported claim: nothing flagged", ok.issues.length, 0);
  eq("supported claim: it was checked", ok.checked, 1);
}
{
  const bad = citationIssues(
    "- The billing method is selected during agreement creation and includes Calendar Month and Weekly options. *(GLD-FS-001@1 — Billing)*", sources, others);
  eq("misattributed claim: flagged", bad.issues.length, 1);
  eq("misattributed claim: not-found", bad.issues[0]?.kind, "not-found");
  eq("names where the wording really came from", bad.issues[0]?.foundIn, "task prompt");
}
{
  // A requirement and its source on adjacent labelled lines (the shape one agent used).
  const block = [
    "### REQ-010", "",
    "**Requirement Name:** Credit decision  ",
    "**Requirement Statement:** When exposure exceeds the credit limit the transaction is blocked or routed for approval.  ",
    "**Source Reference:** GLD-FS-002@1 — Credit  ",
    "**Priority:** Not Specified  ",
  ].join("\n");
  eq("labelled block, supported", citationIssues(block, sources, others).issues.length, 0);
  const wrong = block.replace("GLD-FS-002@1", "GLD-FS-001@1");
  eq("labelled block, wrong source", citationIssues(wrong, sources, others).issues.length, 1);
}
{
  const row = "| BR-07 | When exposure exceeds the credit limit the transaction is blocked or routed for approval | GLD-FS-001@1 |";
  eq("table row citing the wrong source", citationIssues(row, sources, others).issues.length, 1);
}
eq("too-short claims are skipped, not guessed at",
  citationIssues("- Equipment status is updated. *(GLD-FS-002@1)*", sources, others).checked, 0);
eq("a citation to a source we cannot read is counted, not judged",
  citationIssues("- When exposure exceeds the credit limit the transaction is blocked or routed for approval. *(GLD-FS-009@1)*", sources, others).unverifiable, 1);
eq("version suffix and case do not matter", citationKey("gld-fs-001@3"), "GLD-FS-001");
eq("an input document is a citation too", citationKey("inputs/Spec.MD"), "inputs/spec.md");
{
  const r = citationIssues(
    "- The billing method is selected during agreement creation and includes Calendar Month and Weekly options. *(GLD-FS-001@1)*", sources, others);
  const text = formatCitationReport(r) ?? "";
  if (!text.includes("GLD-FS-001") || !text.includes("task prompt")) fail("citation report should name the citation and the real source");
  if (!text.includes("does not judge whether the claim is true")) fail("citation report must say what it does not claim");
}
eq("a clean artifact produces no report", formatCitationReport(citationIssues("Nothing cited here at all.", sources, others)), null);
{
  const long = ("- When exposure exceeds the credit limit the transaction is blocked or routed for approval. *(DR section 2)*\n").repeat(20);
  const r = citationIssues(long, sources, others);
  eq("abbreviated citations: nothing checked", r.checked, 0);
  const note = noCheckableCitations(r, long.length) ?? "";
  if (!note.includes("could not run") || !note.includes("inputs/<file>.md")) fail("a document nothing could check must say the check did not run");
  eq("a short document is left alone", noCheckableCitations(r, 300), null);
  eq("a document with checkable citations needs no such note",
    noCheckableCitations(citationIssues("- When exposure exceeds the credit limit the transaction is blocked or routed for approval. *(GLD-FS-002@1)*".repeat(1), sources, others), 5000), null);
}

// --- terms defined differently -------------------------------------------------------
{
  const defs = extractDefinitions([
    "Reservation represents confirmed future demand.",
    "- **Allocation:** Assignment of a specific asset to an approved",
    "    reservation or agreement.",
    "| Term | Meaning |", "| --- | --- |",
    "| Charge | A priced component such as rent, delivery or damage. |",
    "This is something that is simply described in a sentence.",
  ].join("\n"), "s");
  eq("sentence, wrapped list item and glossary row are found; header and pronoun are not",
    defs.map((d) => d.term).sort(), ["Allocation", "Charge", "Reservation"]);
  if (!defs.find((d) => d.term === "Allocation")?.text.includes("reservation or agreement")) fail("wrapped continuation lines should be joined");
}
{
  const c = termConflicts([
    { name: "prompt", text: "Reservation represents confirmed future demand." },
    { name: "glossary", text: "- **Reservation:** A time-bounded request or hold on availability, not necessarily a confirmed contract." },
  ]);
  eq("the same term defined in unlike words is a candidate conflict", c.map((x) => x.term), ["Reservation"]);
  eq("both wordings are reported with their sources", c[0]?.versions.map((v) => v.source), ["prompt", "glossary"]);
}
{
  const sources = [
    { name: "inputs/spec.md", text: "Reservation represents confirmed future demand." },
    { name: "GLD-REF-1 (glossary)", text: "- **Reservation:** A time-bounded hold on availability that is not necessarily a confirmed contract." },
    { name: "GLD-REF-2 (standards)", text: "- **Database:** The relational store that holds every tenant record and its audit trail." },
    { name: "GLD-REF-3 (architecture)", text: "- **Database:** A managed cloud service used only for platform metadata such as tenant registration." },
  ];
  const anchor = (n: string) => n.startsWith("inputs/");
  eq("without an anchor, library items disagreeing among themselves are reported too",
    termConflicts(sources).map((c) => c.term).sort(), ["Database", "Reservation"]);
  eq("anchored to the project's documents, only conflicts involving them are reported",
    termConflicts(sources, 0.4, anchor).map((c) => c.term), ["Reservation"]);
}
eq("the same definition worded alike is not a conflict",
  termConflicts([
    { name: "a", text: "Agreement is the central rental contract." },
    { name: "b", text: "- **Agreement:** The central rental contract." },
  ]).length, 0);
eq("a term defined in only one source is not a conflict",
  termConflicts([{ name: "a", text: "Quote represents initial commercial proposal." }, { name: "b", text: "Nothing relevant here." }]).length, 0);
eq("two definitions inside ONE source are not a cross-source conflict",
  termConflicts([{ name: "a", text: "Quote represents initial commercial proposal.\nQuote represents something quite different entirely." }]).length, 0);
{
  const conflicts = [{ term: "Reservation", versions: [] }, { term: "Quote", versions: [] }];
  eq("a document silent on conflicts leaves every term unaddressed",
    unaddressedConflicts("# BRD\nReservation and Quote are covered.", conflicts), ["Reservation", "Quote"]);
  eq("naming the conflict and the term addresses it",
    unaddressedConflicts("Source Conflict Identified: Reservation — prompt says X, glossary says Y.", conflicts), ["Quote"]);
}

eq("a status flow is not a definition, so it cannot conflict with a purpose statement",
  termConflicts([
    { name: "inputs/spec.md", text: "Quote represents initial commercial proposal." },
    { name: "GLD-REF-9", text: "- **Quote:** draft → priced → sent → accepted/rejected/expired." },
  ]).length, 0);

// --- formulas written differently by two sources ----------------------------------------
{
  const c = termConflicts([
    { name: "task prompt", text: "Exposure = Outstanding AR + Unbilled Rental Value + Current Transaction Value" },
    { name: "inputs/req.md", text: "Total Exposure = Open AR + Unbilled Rental + New Order Value" },
  ]);
  eq("the same formula with a different component is a conflict, and 'Total' is ignored", c.map((x) => x.term), ["Exposure"]);
  eq("a formula worded alike is not",
    termConflicts([
      { name: "a", text: "Exposure = Open AR + Unbilled Rental + New Order Value" },
      { name: "b", text: "Total Exposure = Open AR + Unbilled Rental + New Order Value" },
    ]).length, 0);
}

// --- roles that appear in no source -----------------------------------------------------
{
  const sources = [
    "The Branch Manager approves exceptions. Finance User is an example role for screen views.",
    "Business Stakeholder, Operational Stakeholder.",
  ];
  const doc = [
    "| SH-01 | Executive Leadership | Funding |",
    "| SH-02 | Insurance / Compliance Team | Reviews cover |",
    "The Branch Manager approves exceptions.",
    "A Finance User may change a view.",
    "Business Stakeholder interest is credit risk.",
    "Through Personalized and Adaptable User Experience the screens match roles.",
    "Each Sales Representative sees quotes.",
  ].join("\n");
  const r = inventedRoles(doc, sources);
  eq("roles no source names are listed", r.sort(), ["Executive Leadership", "Insurance / Compliance Team", "Sales Representative"]);
  if (r.includes("Branch Manager") || r.includes("Finance User")) fail("a role a source names must not be flagged");
  if (r.some((x) => /Experience/.test(x))) fail("'User Experience' is not a role");
  if (r.some((x) => /^(The|Each|A) /.test(x))) fail("a leading determiner must be stripped from the role");
  eq("plural and singular are the same role",
    inventedRoles("The Branch Managers meet weekly.", ["Branch Manager"]), []);
  eq("a single ordinary word is never a role", inventedRoles("The Team agreed. Users log in.", ["nothing"]), []);
  if (!(formatInventedRoles(r) ?? "").includes("Not specified in source")) fail("the roles note should say what to write instead");
  eq("no roles, no note", formatInventedRoles([]), null);
}

// --- template structure ---------------------------------------------------------------
{
  const tpl = "# BRD\n## Business Objectives\n## Success Criteria\n## Target Audience\n## Stakeholders\n";
  eq("matching sections, numbering ignored: no deviation",
    JSON.stringify(templateDeviations(tpl, "# T\n## 1. Business Objectives\n## 2. Success Criteria\n## 3. Target Audience\n## 4. Stakeholders")),
    JSON.stringify({ missing: [], extra: [], outOfOrder: false }));
  eq("a missing section is named",
    templateDeviations(tpl, "## Business Objectives\n## Target Audience\n## Stakeholders")?.missing, ["Success Criteria"]);
  eq("an added section is reported",
    templateDeviations(tpl, "## Business Objectives\n## Success Criteria\n## Target Audience\n## Stakeholders\n## Appendix")?.extra, ["Appendix"]);
  eq("sections in a different order are caught",
    templateDeviations(tpl, "## Success Criteria\n## Business Objectives\n## Target Audience\n## Stakeholders")?.outOfOrder, true);
  eq("subsections do not count as sections",
    templateDeviations(tpl, "## Business Objectives\n### Detail\n## Success Criteria\n## Target Audience\n## Stakeholders")?.extra, []);
  eq("a template with no sections checks nothing", templateDeviations("Just prose.", "## Anything"), null);
}

// --- constructs the task forbids -----------------------------------------------------
const PROMPT_PROHIBITING = `
Critical Instructions

Do not generate:

Functional Requirements

Acceptance Criteria

User Stories

Business Rules
`;
eq("a prohibition list names both", constructsProhibitedBy(PROMPT_PROHIBITING), ["user stories", "acceptance criteria"]);
eq("asking for them is not a prohibition",
  constructsProhibitedBy("For each requirement, write user stories and include acceptance criteria."), []);
eq("a task that both forbids and requests one of them forbids neither",
  constructsProhibitedBy("Do not write user stories in the summary.\nInclude acceptance criteria for every requirement."), ["user stories"]);
eq("no mention, no prohibition", constructsProhibitedBy("Write a BRD for the checkout flow."), []);
eq("a mention nowhere near a prohibition does not count",
  constructsProhibitedBy("Please cover user stories in depth.\n" + "x".repeat(700) + "\nDo not add features."), []);
{
  const doc = [
    "## Requirements",
    "As a Finance user, I want to generate a final invoice so that billing completes.",
    "As an administrator, I need to configure views so that screens match roles.",
    "Given a credit limit is exceeded", "When a quote is created", "Then the quote is blocked",
    "## 7. Acceptance Criteria",
  ].join("\n");
  const used = prohibitedUsed(doc, ["user stories", "acceptance criteria"]);
  eq("both stories counted", used.find((u) => u.construct === "user stories")?.count, 2);
  eq("the Given line and the Acceptance Criteria heading both counted", used.find((u) => u.construct === "acceptance criteria")?.count, 2);
  eq("a clean document uses neither", prohibitedUsed("## Objectives\nReduce credit risk.", ["user stories", "acceptance criteria"]), []);
  eq("only the prohibited constructs are reported", prohibitedUsed(doc, ["user stories"]).map((u) => u.construct), ["user stories"]);
}

console.log(`source checks — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
