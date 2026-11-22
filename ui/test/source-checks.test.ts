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
  coverageGaps, formatCoverageGaps, danglingReferences, formatDanglingReferences, omittedDependencies, quoteIssues, requirementText, scopeLines, ungroundedFields,
  dependencyIssues, fieldRowsAsLabels, formatDependencyIssues, formatStrengthIssues, strengthIssues, strengthOf,
  citationIssues, citationKey, citesTaskPrompt, constructsProhibitedBy, extractDefinitions, formatCitationReport,
  formatInventedRoles, inventedRoles, noCheckableCitations, prohibitedUsed, templateDeviations, termConflicts,
  unaddressedConflicts, formatOmittedDependencies, omittedItemSentences, formatOmittedItemSentences, formatUncheckedItems, ownDocuments, isClientDocument,
  fieldValue, itemLedger, formatItemLedger, formatUncheckedDocuments, summarizeItemLedger, degradedSources, formatDegradedSources,
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
eq("a sentence saying the source is silent, or that it is the document's inference, is not a claim about the source",
  [citationIssues("- This role name is not specified in the source documents. It is inferred from the activities described in GLD-FS-001@1 — Billing.", sources, others).issues.length,
   citationIssues("- The organisation's motivation is inferred from the billing and credit sections of GLD-FS-002@1 and does not repeat them.", sources, others).issues.length,
   citationIssues("- The billing method is selected during agreement creation and includes Calendar Month and Weekly options. *(GLD-FS-001@1 — Billing)*", sources, others).issues.length],
  [0, 0, 1]);
{
  const { duplicateRequirements, formatDuplicateRequirements } = await import("../src/source-checks.js");
  const req = (id: string, s: string) => `#### ${id} — x\n\n**Requirement Statement:** ${s}\n\n**Priority:** Not specified in source.\n`;
  const doc = ["## 6. Requirements", "### 6.1 Quotes", req("REQ-001", "Quotes should convert into Reservation or Rental Agreement while retaining previously approved pricing."), req("REQ-002", "Charges may be applied."),
    "### 6.5 Agreements", req("REQ-010", "Quotes should convert into: Reservation, Rental Agreement, while retaining previously approved pricing."), req("REQ-011", "Charges may be applied."),
    req("REQ-012", "The agreement should identify customer insurance, LDW application and the related charges for the rental.")].join("\n\n");
  const d = duplicateRequirements(doc);
  eq("two areas stating the same requirement are found; short common statements and distinct ones are not", d.map((x) => x.ids), [["REQ-001", "REQ-010"]]);
  eq("the note names them", /REQ-001, REQ-010/.test(formatDuplicateRequirements(d) ?? ""), true);
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

// --- dependencies must quote a source ----------------------------------------------------
{
  const texts = [
    "Delivery cannot be planned until an Agreement exists. Equipment is held against the Reservation until delivery.",
    "Rebilling follows a credit memo only where the customer disputes the invoice.",
  ];
  const doc = [
    "### REQ-007", "",
    "**Requirement Statement:** Delivery is planned after the agreement.  ",
    '**Dependencies:** REQ-003 — “Delivery cannot be planned until an Agreement exists.”  ', "",
    "### REQ-008", "",
    "**Dependencies:** REQ-007  ", "",
    "### REQ-009", "",
    '**Dependencies:** REQ-008 — “Payment is taken before the equipment leaves the yard.”  ', "",
    "### REQ-010", "",
    "**Dependencies:** Not specified  ", "",
    "### REQ-011", "",
    "**Dependencies:** None identified  ", "",
    "**REQ-012** — A requirement written inline.", "Dependencies: REQ-011",
  ].join("\n");
  const r = dependencyIssues(doc, texts);
  eq("trivial dependencies are not counted", r.checked, 4);
  eq("a quoted, real source sentence passes; the others are flagged",
    r.issues.map((i) => `${i.requirement}:${i.reason}`), ["REQ-008:no-quote", "REQ-009:quote-not-found", "REQ-012:no-quote"]);
  eq("an ellipsis may join two fragments of one source sentence",
    dependencyIssues('REQ-1 — x.\nDependencies: REQ-0 — “Delivery cannot be planned … until an Agreement exists.”', texts).issues.length, 0);
  eq("a quote of fewer than four words proves nothing",
    dependencyIssues("**Dependencies:** REQ-0 — “Agreement exists soon”", texts).issues.length, 1);
  eq("'Not specified' in italics is no dependency (it was flagged 60 times in one live document)",
    dependencyIssues("**Dependencies:** *Not specified in source.*\n\n**Dependencies:** _None identified_", texts).checked, 0);
  // A requirement written as a table is read like one written as labelled lines.
  const table = [
    "#### REQ-020 — Pricing", "",
    "| Field | Detail |", "|---|---|",
    "| Requirement ID | REQ-020 |",
    "| Dependencies | REQ-044 — Not stated as explicit dependency in source. |",
    "| Priority | Not specified in source |", "",
    "#### REQ-021 — Tax", "",
    "| Field | Detail |", "|---|---|",
    "| Dependencies | Not specified in source |",
    "| Dependencies | REQ-0 — “Delivery cannot be planned … until an Agreement exists.” |",
  ].join("\n");
  eq("a table row is not a dependency check target as written", dependencyIssues(table, texts).checked, 0);
  const rows = fieldRowsAsLabels(table);
  const t = dependencyIssues(rows, texts);
  eq("as labelled lines, an unquoted dependency in a table is flagged and the quoted one passes", [t.checked, t.issues.map((i) => `${i.requirement}:${i.reason}`)], [2, ["REQ-020:no-quote"]]);
  eq("a table of something else is left alone", fieldRowsAsLabels("| Field | Detail |\n|---|---|\n| Version | 1.0 |\n"), "| Field | Detail |\n|---|---|\n| Version | 1.0 |\n");
  const note = formatDependencyIssues(r) ?? "";
  if (!note.includes("Not specified") || !note.includes("REQ-008")) fail("the dependency note should name the requirement and the way out");
  eq("no issues, no note", formatDependencyIssues({ checked: 2, issues: [] }), null);
}

// --- the source's strength must be kept ---------------------------------------------------
{
  const src = new Map([["GLD-FS-002", [
    "The system should hold a credit limit for each customer account record in the billing ledger.",
    "Delivery may capture signatures and photos of the delivered equipment at the customer site.",
    "Invoices are generated on the billing schedule until the agreement closes for the customer account.",
    "A required field must be completed before a quote is saved to the customer account.",
    "Can sales users override rental pricing during quote creation for large orders?",
  ].join("\n")]]);
  const flag = (claim: string, cite = "GLD-FS-002@1") => strengthIssues(`- ${claim} *(${cite})*`, src).length;

  eq("should written as shall is flagged", flag("The system shall hold a credit limit for each customer account record in the billing ledger."), 1);
  eq("may written as must is flagged", flag("Delivery must capture signatures and photos of the delivered equipment at the customer site."), 1);
  eq("should kept as should passes", flag("The system should hold a credit limit for each customer account record in the billing ledger."), 0);
  eq("may kept as may passes", flag("Delivery may capture signatures and photos of the delivered equipment at the customer site."), 0);
  eq("a source with no modal says nothing about strength", flag("Invoices shall be generated on the billing schedule until the agreement closes for the customer account."), 0);
  eq("a mandatory source stays mandatory", flag("A required field must be completed before a quote is saved to the customer account."), 0);
  eq("an open question carries no strength to harden",
    flag("Sales users will override rental pricing during quote creation for large orders."), 0);
  eq("a question in the document is not a requirement", flag("Must sales users override rental pricing during quote creation for large orders?"), 0);
  eq("an unrelated sentence is not compared", flag("The warehouse shall open at nine every morning without exception."), 0);
  eq("'required' as an adjective is not a modal",
    strengthOf("Enter the required fields."), null);
  eq("'is required' is", strengthOf("A signature is required."), 2);
  eq("should is recommended", strengthOf("Rules should be enforced."), 1);
  eq("may is permissive", strengthOf("Delivery may capture photos."), 0);
  eq("the strongest modal wins", strengthOf("It may be sent and shall be logged."), 2);

  // The ID-led layout: statement on one line, quoted source on the next.
  const block = [
    "**REQ-001** — The system shall hold a credit limit for each customer account record in the billing ledger.",
    '*Source: GLD-FS-002@1 — “The system should hold a credit limit for each customer account record in the billing ledger.”*',
    "", "**REQ-002** — Delivery may capture signatures and photos of the delivered equipment at the customer site.", "*Source: GLD-FS-002@1*",
  ].join("\n");
  eq("a statement and its source line on the next line are one unit", strengthIssues(block, src).length, 1);
  const note = formatStrengthIssues(strengthIssues(block, src)) ?? "";
  if (!note.includes("shall") || !note.includes("should")) fail("the strength note should name both words");
}

// --- the citation list is complete enough to act on -----------------------------------------
{
  const many = Array.from({ length: 45 }, (_, i) =>
    `- The billing method number ${i} is selected during agreement creation and includes Calendar Month options. *(GLD-FS-001@1)*`).join("\n");
  const r = citationIssues(many, sources, others);
  const text = formatCitationReport(r) ?? "";
  eq("up to forty misses are listed, not six", (text.match(/does not appear to contain/g) ?? []).length, 40);
  if (!text.includes("and 5 more")) fail("what is not listed should be counted");
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

// Pointers to parts of the document that do not exist (the run-7 BRD cited "Section 7" 57 times and never wrote it).
{
  const doc = [
    "# BRD", "## 1. Purpose", "Text.", "## 4. Requirements", "### 4.1 Orders",
    "| REQ-001 | Orders are created. | See Section 7 and OQ-001, OQ-002, OQ-003. |",
    "- REQ-002 — Orders are billed. Depends on REQ-001 and REQ-009. Encoded as UTF-8; see Section 4.1.",
    "Golden item GLD-REF-030 defines Reservation.",
  ].join("\n");
  const d = danglingReferences(doc);
  eq("a missing section is found", d.sections, ["7"]);
  eq("a nested section that exists is fine", d.sections.includes("4.1"), false);
  eq("undefined IDs are found (the prefix is used 3+ times)", d.ids, ["OQ-001", "OQ-002", "OQ-003", "REQ-009"]);
  eq("defined IDs, golden items and stray hyphenated words are not flagged", d.ids.some((i) => i === "REQ-001" || i.startsWith("GLD") || i.startsWith("UTF")), false);
  eq("IDs that a source uses itself are the source's own", danglingReferences(doc, ["Open question OQ-001 OQ-002 OQ-003 stays."]).ids, ["REQ-009"]);
  eq("a document without numbered headings has no section claims", danglingReferences("Text. See Section 7.").sections, []);
  eq("a clean document reports nothing", formatDanglingReferences(danglingReferences("## 1. A\n- REQ-001 x\nSee Section 1 and REQ-001.")), null);
  if (!(formatDanglingReferences(d) ?? "").includes("Section 7")) fail("the report should name the missing section");
  // Run 20's layout: a bold ID on its own line, then a field table with a "Requirement ID" row.
  const bold = ["## 6. Requirements", "**REQ-004**", "", "| Field | Value |", "|---|---|", "| Requirement ID | REQ-004 |", "| Requirement Name | Credit |", "", "**REQ-005**", "", "See REQ-004 and REQ-005 and REQ-006."].join("\n");
  eq("a bold ID on its own line, or a Requirement ID row, defines the requirement", danglingReferences(bold).ids, ["REQ-006"]);
}


// Omissions and the review fixes: scope coverage, stated dependencies, verbatim quotes, hedges, softening, ungrounded fields.
{
  const scope = "SPRINT 2 APPROVED SCOPE\n\nRental Reservations\n\nMulti Equipment Rentals Multi Configuration Rentals\n\nBilling\n\nPost Billing Pre Billing Billing Methods\n\nAnything outside this list is out of scope.\n\nLater text.";
  eq("the scope list is read between its heading and the out-of-scope line", scopeLines(scope), ["Rental Reservations", "Multi Equipment Rentals Multi Configuration Rentals", "Billing", "Post Billing Pre Billing Billing Methods"]);
  const covered = [
    "## Requirements", "### REQ-001 — Multi equipment", "A reservation can include multiple items of equipment as a multi equipment rental.",
    "### REQ-002 — Multi configuration", "Multi configuration rentals carry several configurations.",
    "### REQ-003 — Billing", "Post billing and pre billing are billing methods.",
  ].join("\n");
  eq("a covered scope reports nothing", coverageGaps(covered, [scope]).gaps, []);
  const dropped = covered.replace(/### REQ-001[\s\S]*### REQ-002/, "### REQ-002").replace("Multi configuration rentals carry several configurations.", "Configurations can be chosen.");
  eq("a dropped scope item is reported", coverageGaps(dropped, [scope]).gaps.length > 0, true);
  eq("mentioning the item outside a requirement does not count", coverageGaps(dropped + "\n## Key features\nKF-04 — Multi equipment rentals", [scope]).gaps.length > 0, true);
  eq("no scope list, no claims", coverageGaps(dropped, ["Plain text with no list."]), { scopeLines: 0, gaps: [] });
  // A scope category is covered by the heading of the section that holds its requirements.
  const cat = "SPRINT 2 APPROVED SCOPE\n\nCredit Management & Collections Credit Limit Allocation\n\nAnything outside this list is out of scope.";
  const area = ["## 6. Requirements", "### 6.2 Credit Management and Collections", "", "Intro.", "",
    "#### REQ-001 — Credit limit allocation", "The system should allocate a credit limit.", "#### REQ-002 — Exposure", "Exposure is checked.",
    "#### REQ-003 — Status", "Status is kept.", "#### REQ-004 — Holds", "Holds apply.", "#### REQ-005 — Past due", "Past due invoices count."].join("\n");
  eq("a scope category named by the heading of its requirements' section is covered", coverageGaps(area, [cat]).gaps, []);
  eq("the same words in a heading with no requirements under it do not count",
    coverageGaps(area.replace("### 6.2 Credit Management and Collections", "### 6.2 Credit") + "\n## 8. Key Features — Credit Management and Collections\nText.", [cat]).gaps.length > 0, true);
  eq("requirementText keeps requirements only", requirementText("### OQ-001 — q\nQuestion text\n### REQ-001 — a\nrequirement one\n### REQ-002 — b\nrequirement two\n### REQ-003 — c\nc\n### REQ-004 — d\nd\n### REQ-005 — e\ne\n").includes("Question text"), false);
}
{
  const src = ["The cost of insurance is high. This creates a dependency on the LDW process. Billing depends on returns.", "Template: Business Objective Inputs Outputs Dependencies Upstream Impact Downstream Impact."];
  const gone = omittedDependencies("## REQ-001\nThe system invoices rentals.", src);
  eq("a source-stated dependency missing from the document is found", gone.map((g) => g.sentence), ["This creates a dependency on the LDW process."]);
  eq("a field list in a template is not a dependency", gone.some((g) => /Upstream/.test(g.sentence)), false);
  eq("once the document carries it, it is not reported", omittedDependencies("REQ-001 — Dependencies: LDW — “This creates a dependency on the LDW process.”", src), []);
}
{
  const src = ["The invoice lists charges. Charges can be applied at: Agreement, Quote, Reservation. Behavior is configurable."];
  const doc = [
    "REQ-1 — Verbatim: “The invoice lists charges.”",
    "REQ-2 — Joined list: “Charges can be applied at: Agreement.”",
    "REQ-3 — Spelling: “Behaviour is configurable and flexible.”",
    "REQ-4 — Skip: “The invoice … charges” appears in the source.",
    "REQ-5 — Invented: “Every invoice must be approved by a director before release.”",
  ].join("\n");
  const q = quoteIssues(doc, src);
  eq("verbatim and elided quotes pass", q.issues.some((i) => /^The invoice/.test(i.quote)), false);
  eq("a quote that is not the source's words is reported", q.issues.some((i) => /Behaviour/.test(i.quote)), true);
  eq("a quote found nowhere is reported as such", q.issues.find((i) => /director/.test(i.quote))?.kind, "not-in-any-source");
  eq("short quotes are not checked", quoteIssues("Status is “Not Specified in Source”.", src).checked, 0);
}
{
  // Quotes may read across a lead-in line and its bullets, or across bullets; not across a heading, a table row or a file.
  const src = [
    "## Billing\n\nCredit checks should occur during:\n\n- Quote Creation\n- Reservation Creation\n- Agreement Creation\n\nThe invoice lists every charge applied.\n\n## One-Time Charges\n\nCharged once during the rental lifecycle.\n\n| Fee | Setup Fee for new sites |\n| Fee | Delivery Fee per trip |",
    "Final invoices are issued at the end of the rental period",
  ];
  const doc = [
    "REQ-1 — “Credit checks should occur during: Quote Creation, Reservation Creation, Agreement Creation”",
    "REQ-2 — “Reservation Creation, Agreement Creation, The invoice lists every charge applied.”",
    "REQ-3 — “One-Time Charges — Charged once during the rental lifecycle.”",
    "REQ-4 — “Charged once during the rental lifecycle.”",
    "REQ-5 — “Setup Fee for new sites Fee Delivery Fee per trip”",
  ].join("\n");
  const q = quoteIssues(doc, src);
  const kinds = (re: RegExp) => q.issues.find((i) => re.test(i.quote))?.kind ?? null;
  eq("a lead-in with its bullets is one passage", kinds(/^Credit checks/), null);
  eq("consecutive bullets and a paragraph are one passage", kinds(/^Reservation Creation, Agreement/), null);
  eq("a heading joined to its body is flagged", kinds(/^One-Time Charges —/), "joined");
  eq("the body on its own is fine", kinds(/^Charged once/), null);
  eq("two table rows run together are flagged", kinds(/^Setup Fee/), "joined");
  const files = quoteIssues("REQ-9 — “the delivery record is closed and then final invoices are issued”", ["Notes: the delivery record is closed", "and then final invoices are issued"]);
  eq("the end of one file joined to the start of the next is flagged", files.issues.map((i) => i.kind), ["joined"]);
}
{
  // Agents write a requirement's fields with a blank line between each, sometimes with the value under a lone label.
  // Read line by line, the statement and its Source Reference were separate and the statement was checked against nothing.
  const sources = new Map([[citationKey("inputs/a.md"), "The requirement explicitly references rebilling. This suggests corrected invoices can be regenerated after adjustments are made. Invoices should be emailed to the customer after approval by finance."]]);
  const fabricated = "The vendor portal shall expose a quantum ledger for zebras and moonbeams.";
  const make = (statement: string, alone: boolean) =>
    `#### REQ-1 — T\n\n**Requirement Statement:**${alone ? "\n" : " "}${statement}\n\n**Source Reference:** \`inputs/a.md\` — Rebill.\n\n**Priority:** Not specified.\n`;
  for (const alone of [false, true]) {
    const where = alone ? "a statement under a lone label" : "an inline statement";
    eq(`${where}, a blank line from its source, is checked against it`, citationIssues(make(fabricated, alone), sources).issues.map((i) => i.kind), ["not-found"]);
    eq(`${where} that the source supports passes`, citationIssues(make("Invoices should be emailed to the customer after approval by finance.", alone), sources).issues, []);
    eq(`${where} that hardens a hedge is found`, strengthIssues(make("The system shall support rebilling, allowing corrected invoices to be regenerated after adjustments.", alone), sources).map((h) => [h.claimWord, h.sourceWord]), [["shall", "suggests"]]);
  }
  // A short claim is the same sentence as a long source one when most of the claim sits inside it.
  const long = new Map([[citationKey("inputs/a.md"), "During return processing, the system should capture operational return details such as return date, meter readings, fuel level and equipment condition for every returned unit."]]);
  eq("a short claim inside a long 'should' sentence is matched to it", strengthIssues("REQ-4 — The return process shall capture meter readings and fuel level. Source: inputs/a.md", long).map((h) => [h.claimWord, h.sourceWord]), [["shall", "should"]]);
  // A statement that keeps the source's own "may" sentence next to its "should" holds two strengths; each is compared on its own.
  const mixed = new Map([[citationKey("inputs/a.md"), "The system should maintain credit status values including at minimum: Approved, COD (Cash on Delivery), and Hold. Additional statuses may emerge during discovery."]]);
  eq("a 'may' sentence kept beside a 'should' sentence is not a finding",
    strengthIssues(make("The system should maintain credit status values including at minimum: Approved, COD (Cash on Delivery), and Hold. Additional statuses may emerge during discovery.", true).replace("a.md", "a.md"), mixed), []);
  eq("but hardening that source's should to shall still is",
    strengthIssues(make("The system shall maintain credit status values including at minimum: Approved, COD (Cash on Delivery), and Hold. Additional statuses may emerge during discovery.", true), mixed).map((h) => [h.claimWord, h.sourceWord]), [["shall", "should"]]);
  // Quoted words are the source's, not the claim's: a paragraph that quotes a source sentence with "required" in it is not a mandate.
  const quoted = new Map([[citationKey("inputs/a.md"), "Only when equipment comes back can the business accurately determine how long the equipment was rented, whether cleaning is needed, whether damage occurred."]]);
  eq("a modal inside quotation marks is not the claim's",
    strengthIssues("**Current Business Challenge:** `inputs/a.md` (Return) states: “Only when equipment comes back can the business accurately determine how long the equipment was rented, whether cleaning is required, whether damage occurred.”\n", quoted), []);
  eq("a modal outside the quotation still counts",
    strengthIssues("REQ-8 — The business is required to accurately determine how long the equipment was rented, whether cleaning is needed, whether damage occurred. Source: inputs/a.md", quoted).map((h) => [h.claimWord, h.sourceWord]), [["is required", "can"]]);
  // The task prompt is a source like any other. A list under "may include:" that a requirement makes mandatory is a finding;
  // before, a requirement citing "task prompt" was never compared with it.
  const prompt = new Map([[citationKey("task prompt"), "Agreement is the invoice source.\n\nInvoice may include:\n\nRental Charges Misc Charges LDW Charges Sales Items Taxes\n\nInvoice Lifecycle:\n\nGenerate → Review → Finalize"]]);
  const promptReq = (statement: string) => `#### REQ-1\n\n**Requirement Statement:** ${statement}\n\n**Source Reference:** task prompt — Invoice Processing: “Invoice may include: Rental Charges, Misc Charges, LDW Charges, Sales Items, Taxes.”\n\n**Priority:** Not specified.\n`;
  eq("a 'may include' list made mandatory is found, citing the task prompt",
    strengthIssues(promptReq("The invoice shall include LDW Charges."), prompt).map((h) => [h.citation, h.claimWord, h.sourceWord]), [["task prompt", "shall", "may"]]);
  eq("keeping the 'may' is not a finding", strengthIssues(promptReq("The invoice may include LDW Charges."), prompt), []);
  eq("a claim about something else that shares a few words is not matched to the list",
    strengthIssues(promptReq("Pricing must flow forward consistently when an invoice is generated from the agreement."), prompt), []);
  eq("a requirement citing the task prompt is checked for wording too",
    citationIssues(promptReq("The system shall support rebilling, allowing corrected invoices to be regenerated after adjustments."), prompt).issues.map((i) => i.kind), ["not-found"]);
  eq("a source reference to the task prompt is detected, in any case", ["**Source Reference:** Task Prompt — Billing", "task prompt — Billing", "task prompt: “Billing”"].map(citesTaskPrompt), [true, true, true]);
  eq("prose that mentions the task prompt is not a citation of it", ["as defined by the task prompt:", "the task prompt says"].map(citesTaskPrompt), [false, false]);
  eq("prose that merely mentions the task prompt cites nothing",
    citationIssues("Priority is applied as defined by the task prompt: the order below.", prompt).checked, 0);
  // A bullet list belongs to the lead-in above it: a claim naming every item is that sentence, whatever its modal.
  const bullets = new Map([[citationKey("inputs/a.md"), "Credit Validation\n\nCredit checks should occur during:\n\n-   Quote Creation\n-   Reservation Creation\n-   Agreement Creation\n\nThe process should also support credit memos, rebills, and financial posting to Accounts Receivable."]]);
  const bulletReq = (statement: string) => make(statement, false);
  eq("a claim that names all the bullets and says 'must' is found",
    strengthIssues(bulletReq("Credit checks must occur during Quote creation, Reservation creation, and Agreement creation."), bullets).map((h) => [h.claimWord, h.sourceWord]), [["must", "should"]]);
  eq("keeping the 'should' is not a finding",
    strengthIssues(bulletReq("Credit checks should occur during Quote creation, Reservation creation, and Agreement creation."), bullets), []);
  eq("a very short claim is matched when all its words are in one 'should' sentence",
    strengthIssues(bulletReq("The process must support credit memos."), bullets).map((h) => [h.claimWord, h.sourceWord]), [["must", "should"]]);
  // Two requirements with no heading between them are two units, not one long claim.
  const two = make("Invoices should be emailed to the customer after approval by finance.", true) + "\n" + make(fabricated, true).replace("REQ-1", "REQ-2");
  eq("the next requirement's fields are not merged into the first", citationIssues(two, sources).issues.map((i) => i.claim.slice(0, 20)), ["The vendor portal sh"]);
  // An Open Question cites its own source; it is not part of the statement's evidence.
  const withOq = make("Invoices should be emailed to the customer after approval by finance.", true) + "\n**Open Questions:**\n- Who approves? (`inputs/a.md` — approval)\n";
  eq("open questions are not folded into the statement", citationIssues(withOq, sources).issues, []);
  // Labelled blocks without a Requirement Statement keep their old, adjacent-lines-only grouping.
  const prose = "**Business Problem:** Delivery is a risk.\n\n**Source Reference:** `inputs/a.md` — Rebill.\n";
  eq("a non-requirement block is not joined to its source line", citationIssues(prose, sources).checked, 0);
}
{
  // A hedged source is below "may"; softening an obligation is its own finding.
  const sources = new Map([[citationKey("inputs/a.md"), "This suggests that corrected invoices can be regenerated after review. Invoices must be approved by finance before release to customers."]]);
  const hardened = strengthIssues("REQ-1 — Corrected invoices should be regenerated after review. Source: inputs/a.md", sources);
  eq("a hedge hardened to should is found", hardened.map((h) => [h.claimWord, h.sourceWord, h.direction ?? null]), [["should", "suggests", null]]);
  const weak = strengthIssues("REQ-2 — Invoices should be approved by finance before release to customers. Source: inputs/a.md", sources);
  eq("must softened to should is found, marked as weakened", weak.map((h) => [h.sourceWord, h.direction]), [["must", "weakened"]]);
  eq("keeping must is fine", strengthIssues("REQ-3 — Invoices must be approved by finance before release to customers. Source: inputs/a.md", sources), []);
  const msg = formatStrengthIssues([...hardened, ...weak]) ?? "";
  if (!msg.includes("say more than their source") || !msg.includes("say less than their source")) fail("both directions should be reported, each worded for what went wrong");
}
{
  const src = ["The Operations Team may review invoices. Finance approves the credit limit."];
  const doc = [
    "### SH-01 — Operations Team", "**Engagement Level:** Review, Consult", "### SH-02 — Finance Team", "**Engagement Level:** Approve",
    "### SH-03 — Branch Manager", "**Engagement Level:** Not Specified in Source.", "### SH-04 — Sales Group", "**Operational Frequency:** Daily",
  ].join("\n");
  const u = ungroundedFields(doc, src);
  eq("a value no source gives for that role is found", u.map((x) => x.entity), ["Operations Team", "Sales Group"]);
  eq("a value a source gives for that role passes, and 'not specified' passes", u.some((x) => x.entity === "Finance Team" || x.entity === "Branch Manager"), false);
  // As a live run wrote it: italic "Not specified" (and with a trailing note) is the answer asked for, not an invented value.
  const italic = ["### Billing Function", "**Operational Frequency:** *Not specified in source*", "- **Operational Frequency:** *Not specified in source — described as an administrative capability*", "### Sales Group", "**Operational Frequency:** *Daily*"].join("\n");
  eq("italic 'Not specified in source' passes; an italic invented value is still found", ungroundedFields(italic, src).map((x) => x.entity), ["Sales Group"]);
}
{
  // Review fixes: a bare aside is not a definition, and one-letter prefixes count.
  const aside = ["## 1. A", "- OQ-001 — First question", "- OQ-002 (to be raised with Finance)", "- OQ-003 — Third", "See OQ-001, OQ-002 and OQ-003.", "Cited: R-10, R-11 and R-12 in prose."].join("\n");
  const d = danglingReferences(aside);
  eq("an ID followed only by an aside defines nothing", d.ids.includes("OQ-002"), true);
  eq("an ID with a title does define itself", d.ids.includes("OQ-001"), false);
  eq("one-letter prefixes are tracked", d.ids.includes("R-12"), true);
}


{
  // Peer review of the omission checks: silence must not read as a pass, and an appendix quote is not a carried dependency.
  eq('no scope list in a long document says so', (formatCoverageGaps({ scopeLines: 0, gaps: [] }, 12, 50000) ?? '').includes('not checked'), true);
  eq('a short document with no scope list stays quiet', formatCoverageGaps({ scopeLines: 0, gaps: [] }, 12, 500), null);
  const src = ['This creates a dependency on the LDW process.'];
  const appendix = ["### REQ-001 — a", "Invoices are produced.", "## Appendix", "This creates a dependency on the LDW process."].join("\n");
  eq('a dependency quoted only outside the requirements is still omitted', omittedDependencies(appendix, src).length, 1);
  eq('a dependency inside a requirement is carried', omittedDependencies(["### REQ-001 — a", "Dependencies: LDW — This creates a dependency on the LDW process."].join("\n"), src), []);
  // A dependency quoted only under Open Questions, with Dependencies "Not Specified", is not carried (REQ-021/026).
  const hedged = ['Recurring charges may become tightly coupled with billing. This creates dependency on other sprint capabilities.'];
  const inOq = ['#### REQ-021 — Charge Type', '', '**Requirement Statement:** Charges may be billed as one-time or recurring.', '',
    '**Dependencies:** Not Specified.', '', '**Open Questions:** Risk 2 — “This creates dependency on other sprint capabilities.”'].join('\n');
  eq('quoted only under Open Questions, the dependency is still omitted', omittedDependencies(inOq, hedged).length, 1);
  eq('as a Dependency to confirm, it is carried', omittedDependencies(inOq.replace('**Dependencies:** Not Specified.',
    '**Dependencies:** Dependency to confirm: billing — “This creates dependency on other sprint capabilities.”'), hedged), []);
  eq('"Not Specified" followed by the quote in brackets still carries nothing', omittedDependencies(inOq.replace('**Dependencies:** Not Specified.',
    '**Dependencies:** Not Specified. (Recorded as a risk: “This creates dependency on other sprint capabilities.”)'), hedged).length, 1);
  eq('the report names the Dependency to confirm form', (formatOmittedDependencies(omittedDependencies(inOq, hedged)) ?? '').includes('Dependency to confirm:'), true);
}

{
  // A Source Conflict line quotes the other source on purpose: it must not make the statement "not found" there.
  const srcs = new Map([
    [citationKey('inputs/flow.md'), 'A Reservation represents confirmed future demand held against equipment until delivery.'],
    [citationKey('inputs/reqs.md'), 'Reservation: a time-bounded hold on availability that is not necessarily a confirmed contract.'],
  ]);
  const withConflict = [
    '**Requirement Statement:** A Reservation represents confirmed future demand held against equipment until delivery.', '',
    '**Source Reference:** `inputs/flow.md` — “A Reservation represents confirmed future demand.”', '',
    '**Source Conflict Identified:** `inputs/flow.md` says “confirmed future demand”; `inputs/reqs.md` says “a time-bounded hold on availability”.',
  ].join('\n');
  eq('a conflict line adds no citation to the statement', citationIssues(withConflict, srcs).issues, []);
  eq('a statement that is a recorded conflict is not a claim', citationIssues(
    '**Requirement Statement:** Source Conflict Identified. inputs/flow.md says: “A Reservation represents confirmed future demand held against equipment until delivery.” inputs/reqs.md says: “a time-bounded hold on availability that is not necessarily a confirmed contract.”\n\n**Source Reference:** `inputs/flow.md`; `inputs/reqs.md`', srcs).issues, []);
  eq('the statement is still checked against its own citation', citationIssues(withConflict.replace('A Reservation represents confirmed future demand held against equipment until delivery.', 'Invoices are issued monthly to every customer account by the finance team.'), srcs).issues.length, 1);
}

{
  // Sentences of the cited source item: a purpose sentence left out is flagged; speculation, commentary, tables, other
  // items with the same title elsewhere, and a sentence carried by another requirement citing the item are not.
  const src = new Map([[citationKey('inputs/reqs.md'), [
    '## Reservations', '### Requirement Overview', 'The client requires reservations to be managed across many branches.',
    '### Requirement Breakdown', '#### Fleet Commitment', 'Once reserved, equipment capacity should be committed against the requested dates.',
    'This prevents the same equipment from being promised to multiple customers.', 'This suggests a hard allocation model is needed.',
    'This suggests the business may need to track:', '- Customer deductible amount', '- Damage responsibility thresholds',
    '#### Proof of Delivery', 'The requirement explicitly states: Signed delivery tickets are captured at drop-off.', '| Photos | Visual proof |',
    '#### Charge Type', 'One-time charges are charged once during the rental lifecycle.', 'Recurring charges are charged repeatedly by billing cycle.',
    '## Returns', '### Requirement Breakdown', '#### Fleet Commitment', 'Returned units are released back to available inventory immediately.',
  ].join('\n')]]);
  const req = (id: string, item: string, statement: string, area = 'Reservations') =>
    [`#### REQ-${id} — ${item}`, '', `**Requirement Statement:** ${statement}`, '',
     `**Source Reference:** \`inputs/reqs.md\` — ${area} › Requirement Breakdown › ${item}: “${statement}”`, '', '---'].join('\n');
  const doc = [
    req('001', 'Fleet Commitment', 'Once reserved, equipment capacity should be committed against the requested dates.'),
    req('002', 'Proof of Delivery', 'Signed delivery tickets are captured at drop-off.'),
    req('003', 'Charge Type', 'One-time charges are charged once during the rental lifecycle.'),
    req('004', 'Charge Type', 'Recurring charges are charged repeatedly by billing cycle.'),
  ].join('\n\n');
  const o = omittedItemSentences(doc, src);
  eq('only the purpose sentence of the cited item is flagged', o.map((x) => `${x.reqs.join(',')}|${x.item}|${x.sentence}`),
    ['REQ-001|Fleet Commitment|This prevents the same equipment from being promised to multiple customers.',
     'REQ-001|Fleet Commitment|This suggests the business may need to track: Customer deductible amount Damage responsibility thresholds']);
  eq('nothing flagged once the requirement carries it', omittedItemSentences(doc.replace(
    'against the requested dates.”', 'against the requested dates.” This prevents the same equipment from being promised to multiple customers. ' +
    'The business may need to track: Customer deductible amount, Damage responsibility thresholds.'), src), []);
  eq('the report names the requirement and the sentence', (formatOmittedItemSentences(o) ?? '').includes('REQ-001 — Fleet Commitment: “This prevents'), true);
  eq('a reference naming no heading as a whole segment flags nothing', omittedItemSentences(req('009', 'Fleet', 'Fleet is committed.'), src), []);
  // A numbered Gap / Decision / Risk is cited for its question, not carried sentence by sentence.
  const gapSrc = new Map([[citationKey('inputs/reqs.md'), ['## Reservations', '#### Decision 5', 'Examples: any overdue invoice, thirty days past due, sixty days past due.'].join('\n')]]);
  eq('a cited Decision heading flags nothing', omittedItemSentences(req('011', 'Decision 5', 'Overdue handling is a business decision.'), gapSrc), []);
  // …but an item that merely has "Risk" or "Decision" in its name is a requirement like any other.
  const riskSrc = new Map([[citationKey('inputs/reqs.md'), ['## Credit', '#### Credit Risk Limits', 'Credit limits should be reviewed every quarter.', 'This protects the company from accumulated exposure.'].join('\n')]]);
  eq('an item named "Credit Risk Limits" is still checked', omittedItemSentences(req('012', 'Credit Risk Limits', 'Credit limits should be reviewed every quarter.', 'Credit'), riskSrc).map((x) => x.sentence),
    ['This protects the company from accumulated exposure.']);
  // A long item is not checked sentence by sentence, and says so rather than passing silently.
  const longSrc = new Map([[citationKey('inputs/reqs.md'), ['## Reservations', '#### Long Item', ...Array.from({ length: 60 }, (_, k) => `Sentence number ${k} describes a separate rule for reservations in detail.`)].join('\n')]]);
  const unchecked: string[] = [];
  eq('a long item flags no sentences', omittedItemSentences(req('010', 'Long Item', 'Sentence number 1 describes a separate rule for reservations in detail.'), longSrc, unchecked), []);
  eq('a long item is reported as unchecked', unchecked, ['Long Item (REQ-010)']);
  eq('the unchecked note names it', (formatUncheckedItems(unchecked) ?? '').includes('1 long source item(s)'), true);
  eq('nothing unchecked, no note', formatUncheckedItems([]), null);
}

{
  // Which documents requirements come from: uploaded inputs when there are any, Golden Repository specs only otherwise.
  const names = (xs: { name: string }[]) => xs.map((x) => x.name);
  const mixed = [{ name: 'task prompt' }, { name: 'inputs/Detailed-Requirements-1.md' }, { name: 'GLD-FS-002 (Detailed Requirements)' }, { name: 'GLD-REF-001 (ERP)' }];
  eq('with inputs, GLD-FS items stay reference material and get no area writers', names(ownDocuments(mixed)), ['task prompt', 'inputs/Detailed-Requirements-1.md']);
  const golden = [{ name: 'task prompt' }, { name: 'GLD-FS-001 (Operations Flow)' }, { name: 'GLD-FS-002 (Detailed Requirements)' }, { name: 'GLD-STD-003 (Naming)' }];
  eq('without inputs, the GLD-FS specs are the documents; a standard is not', names(ownDocuments(golden)), ['task prompt', 'GLD-FS-001 (Operations Flow)', 'GLD-FS-002 (Detailed Requirements)']);
  eq('isClientDocument takes a citation key too', [isClientDocument('GLD-FS-002'), isClientDocument('inputs/a.md'), isClientDocument('GLD-REF-001')], [true, true, false]);
}

{
  // A field ends at the next labelled field however it is laid out: a blank line, a single newline, or a bullet.
  const blank = '**Dependencies:** Not Specified.\n\n**Open Questions:** Risk 2 — “x”';
  const single = '**Dependencies:** Not Specified.\n**Open Questions:** Risk 2 — “x”';
  const bullet = '- **Dependencies:** Not Specified.\n- **Open Questions:** Risk 2 — “x”';
  eq('field ends before the next field after a blank line', fieldValue(blank, 'Dependencies')?.trim(), 'Not Specified.');
  eq('field ends before the next field on the next line', fieldValue(single, 'Dependencies')?.trim(), 'Not Specified.');
  eq('field ends before the next bullet field', fieldValue(bullet, 'Dependencies')?.trim(), 'Not Specified.');
  const hedged = ['This creates dependency on other sprint capabilities and related billing work.'];
  for (const [name, layout] of [['single newline', '\n'], ['bullet', '\n- ']] as const) {
    const d = ['#### REQ-021 — Charge Type', '', '**Requirement Statement:** Charges may be billed.', '',
      `**Dependencies:** Not Specified.${layout}**Open Questions:** Risk 2 — “This creates dependency on other sprint capabilities and related billing work.”`].join('\n');
    eq(`a dependency quoted only in Open Questions is still omitted (${name} layout)`, omittedDependencies(d, hedged).length, 1);
  }
  // Deliberately the noun only: verb forms describe a process in nearly every source sentence, so they are left to the
  // writer brief (which names "depends on", "requires … first", "cannot … until") and are not reported here.
  eq('verb forms are not reported by this check (by design)', omittedDependencies('#### REQ-001 — a', [
    'Invoice generation depends on the billing cycle being configured for each agreement.',
    'Delivery requires the agreement to be signed first by the customer.',
    'Pickup cannot be scheduled until the rental has been called off.',
  ]), []);
  eq('the noun with a relation is reported', omittedDependencies('#### REQ-001 — a', ['This requirement has a strong dependency on Insurance and LDW functionality.']).length, 1);
  // The noun alone names a topic, not a dependency.
  eq('"Dependency handling for hidden fields." is not a stated dependency',
    omittedDependencies('#### REQ-001 — a', ['The most critical discovery areas are: Dependency handling for hidden fields across every screen.']), []);
}

{
  // Every source item accounted for.
  const DR = [
    '# Credit', '## Credit Limit Allocation', '### Requirement Breakdown',
    '#### Credit Profile Management', 'The system should maintain customer credit limits and credit status.',
    '#### Credit Validation', 'Credit checks should occur during quote and reservation creation.',
    '#### LDW Configuration', 'LDW rates may vary by category and class.', '##### Equipment Class', 'More granular pricing control for each equipment class.',
    '#### Collections Control', 'Past due invoices should impact future rental transactions.',
    '#### Export Feeds', 'Exports should be produced nightly for the finance warehouse.',
    '### Our Understanding', '#### Analyst Reading', 'The business wants to protect itself from financial risk exposure.',
    '### Information Missing / Requirement Gaps', '#### Gap 1: Ownership', 'Who owns the credit limit and its approvals?',
  ].join('\n');
  const src = new Map([[citationKey('inputs/dr.md'), DR], [citationKey('inputs/flow.md'), 'Phase 1. Quotes are created.\nPhase 2. Reservations follow.']]);
  const req = (id: string, item: string, text: string) =>
    [`#### REQ-${id} — ${item}`, '', `**Requirement Statement:** ${text}`, '', `**Source Reference:** \`inputs/dr.md\` — Credit Limit Allocation › Requirement Breakdown › ${item}: “${text}”`, '', '---'].join('\n');
  const doc = [
    req('001', 'Credit Profile Management', 'The system should maintain customer credit limits and credit status.'),
    req('002', 'LDW Configuration', 'LDW rates may vary by category and class. Class gives more granular pricing control for each equipment class.'),
    // Carries Collections Control's sentence but cites another heading: unresolved.
    ['#### REQ-003 — Overdue invoices', '', '**Requirement Statement:** Past due invoices should impact future rental transactions.', '',
     '**Source Reference:** `inputs/dr.md` — Credit Limit Allocation › Requirement Overview: “Past due invoices should impact future rental transactions.”'].join('\n'),
    '## Out of scope', '', 'Export Feeds is out of scope for this release.',
  ].join('\n\n');
  const l = itemLedger(doc, src);
  const status = Object.fromEntries(l.items.map((x) => [x.item, x.status]));
  eq('each requirement item gets a disposition; analyst sections and Gaps are not items', status, {
    'Credit Profile Management': 'covered', 'Credit Validation': 'not-covered', 'Equipment Class': 'covered-via-parent',
    'Collections Control': 'unresolved', 'Export Feeds': 'excluded',
  });
  eq('a sub-heading covered only through its cited parent is counted apart', l.items.find((x) => x.item === 'Equipment Class'), { status: 'covered-via-parent', item: 'Equipment Class', source: 'inputs/dr.md', reqs: ['REQ-002'] });
  // The parent's requirement drops the child's sentence: the child is unresolved, not covered.
  const dropped = itemLedger(doc.replaceAll(' Class gives more granular pricing control for each equipment class.', ''), src);
  eq('a child the parent requirement does not carry is unresolved', dropped.items.find((x) => x.item === 'Equipment Class')?.status, 'unresolved');
  eq('an unresolved item names the requirement that carries its text', l.items.find((x) => x.item === 'Collections Control'), { status: 'unresolved', item: 'Collections Control', source: 'inputs/dr.md', reqs: ['REQ-003'] });
  eq('a document with no headings is named, not counted as covered', l.noItems, ['inputs/flow.md']);
  const f = formatItemLedger(l) ?? '';
  eq('the report counts every status', f.includes('5 in the client') && f.includes('1 covered, 1 covered via parent, 1 unresolved, 1 excluded, 1 not covered'), true);
  eq('the report lists what is not covered', f.includes('- Credit Validation (inputs/dr.md)'), true);
  eq('the summary line names the unchecked document', summarizeItemLedger(l).includes('no headings): inputs/flow.md'), true);
  eq('nothing to act on, no finding', formatItemLedger({ items: [{ status: 'covered', item: 'A', source: 's', reqs: ['REQ-001'] }], noItems: [] }), null);
  // All covered, but a document had no headings: that is still said, so silence does not read as full coverage.
  const allCovered = { items: [{ status: 'covered' as const, item: 'A', source: 's', reqs: ['REQ-001'] }], noItems: ['GLD-FS-001'] };
  eq('a document not checked item by item is named even when all else is covered', (formatUncheckedDocuments(allCovered) ?? '').includes('Not checked item by item: GLD-FS-001'), true);
  eq('no unchecked document, no note', formatUncheckedDocuments({ items: allCovered.items, noItems: [] }), null);
  eq('when items are missing, formatItemLedger names the unchecked document instead', formatUncheckedDocuments(l), null);
  // Exclusion needs the title near the phrase, and a title long enough to mean something.
  const SH = ['# Area', '## Admin', '### Requirement Breakdown', '#### Status', 'The record should show a status for each rental.',
    '#### Export Feeds', 'Exports should be produced nightly for the finance warehouse.'].join('\n');
  const shSrc = new Map([[citationKey('inputs/sh.md'), SH]]);
  const st = (d: string) => Object.fromEntries(itemLedger(d, shSrc).items.map((x) => [x.item, x.status]));
  eq('a one-word title in an unrelated out-of-scope line is not excluded', st('Order status reports are out of scope for this release.')['Status'], 'not-covered');
  eq('a title far from the exclusion phrase is not excluded',
    st('Export Feeds were discussed at length with the finance team during several workshops, and separately the mobile app is out of scope.')['Export Feeds'], 'not-covered');
  eq('a title next to the exclusion phrase is excluded', st('Export Feeds are out of scope for Sprint 2.')['Export Feeds'], 'excluded');
  eq('a title named twice is excluded when its second mention is near the phrase',
    st('Export Feeds came up in the finance workshop that ran over two full days last month; after review, Export Feeds are out of scope.')['Export Feeds'], 'excluded');
}

{
  // Sources asked for but not used.
  const d = degradedSources({
    inputs: [{ path: 'inputs/a.md', text: 'ok' }, { path: 'inputs/b.md', text: null }, { path: 'inputs/c.md', text: '  ' }],
    selected: [
      { id: 'GLD-FS-001', title: 'Flow', status: 'published', content: 'text' },
      { id: 'GLD-FS-002', title: 'Details', status: 'published', content: null },
      { id: 'GLD-STD-003', title: 'Naming', status: 'archived', content: 'x' },
    ],
    selectedIds: ['GLD-STD-003', 'GLD-REF-009'],
    task: 'Use GLD-FS-001 and GLD-FS-007 as the sources.',
  });
  eq('every source asked for but unusable is named, with why', d, [
    'inputs/b.md: could not be read', 'inputs/c.md: is empty',
    'GLD-FS-002 (Details): selected, but its content could not be read',
    'GLD-STD-003 (Naming): selected, but it is archived, not published',
    'GLD-REF-009: selected for this project, but no such item is available',
    'GLD-FS-007: named in the task, but not selected for this project',
  ]);
  eq('nothing degraded, no finding', formatDegradedSources(degradedSources({ inputs: [{ path: 'inputs/a.md', text: 'ok' }], selected: [], selectedIds: [], task: '' })), null);
}

console.log(`source checks — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
