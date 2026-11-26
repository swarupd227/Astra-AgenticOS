/**
 * Pins the checks in src/source-gaps.ts: Gap and Decision citations, "None" over a listed gap, narrowed lists.
 *
 *   npm test
 *
 * Synthetic text only. Each check is tested on the shape it must flag and the near-miss it must leave alone.
 */
import { cutOffGapLists, formatCutOffLists, formatGapCitations, formatHiddenGaps, formatNarrowedLists, gapCitationIssues, hiddenGaps, narrowedLists, sourceItems } from "../src/source-gaps.js";

let failures = 0;
const fail = (m: string) => { console.error(m); failures++; };
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(want === undefined ? got : got)}`);
};

const DOC = `# **Billing**

## **Billing Methods**

The billing method is chosen on the agreement.

### **Information Missing / Requirement Gaps**

#### **Gap 1: Ownership of Billing Method**

The requirement does not specify where billing preferences originate.

#### **Gap 3: Invoice Timing Rules**

The requirement does not define when invoices are generated or how invoice timing is calculated.

### **Key Business Decisions Required**

#### **Decision 2**

Can users override the default billing method during agreement creation?

# **Credit**

#### **Gap 2: Credit Status Lifecycle**

Who places a customer on Hold? Who removes Hold? Is approval workflow required for credit status changes?

#### **Decision 4**

Who can approve credit exceptions?

# **Reservation**

The reservation holds:

-   Customer
-   Job Site
-   Contact
-   Dates
-   Equipment Requirement
-   Pricing
`;
const SOURCES = new Map([["inputs/billing.md", DOC]]);

// --- the sources' own gaps and decisions -------------------------------------------------
{
  const items = sourceItems(DOC, "inputs/billing.md");
  eq("every Gap and Decision heading is an item", items.map((i) => `${i.kind} ${i.n}`), ["Gap 1", "Gap 3", "Decision 2", "Gap 2", "Decision 4"]);
  eq("a Gap carries its title", items[0].title, "Ownership of Billing Method");
  eq("a Decision with no title still carries its question", items[2].text.includes("override the default billing method"), true);
  eq("prose that begins 'Decision 3 is' is not an item", sourceItems("Decision 3 is pending.\nGap 2 was closed.", "x").length, 0);
}

const req = (id: string, openQuestions: string, extra = "") =>
  `#### ${id} — Something\n\n**Requirement Name:** Billing Method\n\n**Requirement Statement:** ${extra || "The billing method is chosen on the agreement."}\n\n**Source Reference:** \`inputs/billing.md\` — Billing Methods: "The billing method is chosen on the agreement."\n\n**Priority:** Not specified in source.\n\n**Dependencies:** Not specified in source.\n\n**Open Questions:** ${openQuestions}\n\n---\n\n`;
const doc = (...reqs: string[]) => `## 4. Requirements\n\n${reqs.join("")}${reqs.length < 5 ? [1, 2, 3, 4, 5].map((n) => `#### REQ-9${n} — Filler\n\n**Requirement Statement:** x.\n\n`).join("") : ""}`;

// --- 1. Gap and Decision numbers -----------------------------------------------------------
{
  const ok = gapCitationIssues(doc(req("REQ-001", "Where do billing preferences originate? Can users override the default billing method during agreement creation? (Source: `inputs/billing.md` — Billing Methods, Gap 1 and Decision 2.)")), SOURCES);
  eq("references that match their questions are checked and pass", [ok.checked, ok.issues.length], [2, 0]);

  const wrong = gapCitationIssues(doc(req("REQ-001", "Where do billing preferences originate? Can users override the default billing method during agreement creation? (Source: `inputs/billing.md` — Billing Methods, Gaps 1 and 2.)")), SOURCES);
  eq("'Gaps 1 and 2' where no Gap 2 is about the questions is flagged", wrong.issues.map((i) => `${i.requirement} ${i.ref} ${i.reason}`), ["REQ-001 Gap 2 mismatch"]);
  eq("and the closest item is offered", wrong.issues[0].closest?.includes("Decision 2"), true);

  const missing = gapCitationIssues(doc(req("REQ-001", "Where do billing preferences originate? (Source: `inputs/billing.md` — Billing Methods, Gap 9.)")), SOURCES);
  eq("a number that does not exist is flagged", missing.issues.map((i) => i.reason), ["missing"]);

  const list = gapCitationIssues(doc(req("REQ-001", "Where do billing preferences originate? When are invoices generated and how is invoice timing calculated? (Source: `inputs/billing.md` — Billing Methods, Gaps 1, 3.)")), SOURCES);
  eq("a comma list of numbers is read number by number", [list.checked, list.issues.length], [2, 0]);

  const mixed = gapCitationIssues(doc(req("REQ-001", "Where do billing preferences originate? Can users override the default billing method during agreement creation? (Source: `inputs/billing.md` — Billing Methods, Gap 1 and Decision 2.)")), SOURCES);
  eq("'Gap 1 and Decision 2' reads Decision 2 as a Decision", mixed.issues.length, 0);

  eq("an open question with no reference is left alone", gapCitationIssues(doc(req("REQ-001", "Who owns billing preferences?")), SOURCES).checked, 0);
  eq("a document with no such sources checks nothing", gapCitationIssues(doc(req("REQ-001", "Question? (Source: `inputs/other.md` — X, Gap 1.)")), SOURCES).checked, 0);
  eq("nothing is said when nothing is wrong", formatGapCitations(ok), null);
  eq("what is said names the requirement and the reference", /REQ-001: cites Gap 2/.test(formatGapCitations(wrong) ?? ""), true);
}

// --- 2. "None" over a listed gap ------------------------------------------------------------
{
  const subject = "Users can override the default billing method during agreement creation; billing method ownership is set on the customer.";
  const hidden = hiddenGaps(doc(req("REQ-001", "None.", subject)), SOURCES);
  eq("'None' over a requirement a Decision is about is reported with the item", hidden.map((h) => h.requirement), ["REQ-001"]);
  eq("and the report names the item", hidden[0]?.items.some((s) => s.startsWith("Decision 2")), true);
  eq("a question that is recorded is not reported", hiddenGaps(doc(req("REQ-001", "Can users override the default billing method? (Source: `inputs/billing.md` — Billing Methods, Decision 2.)", subject)), SOURCES).length, 0);
  eq("'None' over a requirement no gap is about is left alone", hiddenGaps(doc(req("REQ-001", "None.", "Equipment is delivered to the job site on the agreed date.")), SOURCES).length, 0);
  eq("'Not specified' counts as none", hiddenGaps(doc(req("REQ-001", "Not specified in source.", subject)), SOURCES).length, 1);
  eq("a credit question does not attach to a billing requirement", hiddenGaps(doc(req("REQ-001", "None.", "The system shall let users approve credit exceptions when billing the agreement.")), SOURCES).length, 0);
  eq("nothing is said when there is nothing", formatHiddenGaps([]), null);
}

// --- a Gap's list quoted partway ---------------------------------------------------------
{
  const src = new Map([["inputs/billing.md", ["#### Gap 6: Insurance Change Management", "", "The requirement addresses insurance expiry.", "", "However it does not define what happens when:", "", "-   Insurance expires during an active rental.", "-   Insurance is replaced during a rental.", "-   Coverage limits change.", "", "These are common business scenarios.", ""].join(String.fromCharCode(10))]]);
  const ask = (oq: string) => cutOffGapLists(doc(req("REQ-001", oq, "The system shall validate insurance during an active rental.")), src);
  const cut = ask("Gap 6: Insurance Change Management — “However it does not define what happens when:”");
  eq("a quote that stops at the colon is reported with what it left out", cut.map((c) => [c.ref, c.missing.length]), [["Gap 6", 3]]);
  eq("one entry of three is reported with the other two", ask("Gap 6: Insurance Change Management — “Insurance expires during an active rental.”").map((c) => c.missing.length), [2]);
  eq("the whole list is quiet", ask("Gap 6: Insurance Change Management — “However it does not define what happens when: Insurance expires during an active rental. Insurance is replaced during a rental. Coverage limits change.”"), []);
  eq("an item cited by its title, with its list not taken up, is quiet", ask("Gap 6: Insurance Change Management — “The requirement addresses insurance expiry.”"), []);
  eq("what is said names the entries", /Coverage limits change/.test(formatCutOffLists(cut) ?? ""), true);
  eq("nothing is said when there is nothing", formatCutOffLists([]), null);
  const opts = new Map([["inputs/billing.md", ["#### Decision 2", "", "What hierarchy should determine the final billing rate during an active rental?", "", "Possible levels:", "", "-   Category", "-   Class", "-   Customer", "", "#### Gap 4: Rental Statuses", "", "The requirement does not define statuses during an active rental.", "", "Potential statuses may include:", "", "-   Draft", "-   Closed", ""].join(String.fromCharCode(10))]]);
  const cite = (oq: string) => cutOffGapLists(doc(req("REQ-001", oq, "The system shall apply the billing rate by category and class during an active rental.")), opts);
  eq("citing a Decision takes up its possible options, whatever is quoted", cite("Decision 2 — “What hierarchy should determine the final billing rate?”").map((c) => c.missing), [["Customer"]]);
  eq("another cited list that was not quoted is an illustration and is left alone", cite("Gap 4: Rental Statuses — “The requirement does not define statuses during an active rental.”"), []);
}

// --- 3. Narrowed lists -------------------------------------------------------------------------
{
  const narrow = narrowedLists(doc(req("REQ-001", "None.", "The reservation holds the customer, job site, contact, dates and equipment requirement.")), SOURCES);
  eq("a statement naming 5 of 6 items is reported with what it left out", narrow.map((n) => `${n.present}/${n.total} ${n.missing.join(",")}`), ["5/6 Pricing"]);
  eq("naming every item is quiet", narrowedLists(doc(req("REQ-001", "None.", "The reservation holds the customer, job site, contact, dates, equipment requirement and pricing.")), SOURCES).length, 0);
  eq("'such as' marks examples and is quiet", narrowedLists(doc(req("REQ-001", "None.", "The reservation holds details such as the customer, job site, contact and dates.")), SOURCES).length, 0);
  eq("naming one item of a long list is a different requirement", narrowedLists(doc(req("REQ-001", "None.", "The reservation holds the customer.")), SOURCES).length, 0);
  eq("a short form is the same item ('misc' for miscellaneous)", narrowedLists(doc(req("REQ-001", "None.", "The reservation holds the customer, job site, contact, dates, equipment requirement and miscellaneous charges.")), new Map([["inputs/billing.md", DOC.replace("-   Pricing", "-   Misc Charges")]])).length, 0);
  eq("a list under a Gap heading is questions, not an enumeration", narrowedLists(doc(req("REQ-001", "None.", "The customer, job site, contact, dates and equipment requirement.")),
    new Map([["inputs/billing.md", "#### Gap 1: Reservation\n\nThe reservation holds:\n\n- Customer\n- Job Site\n- Contact\n- Dates\n- Equipment Requirement\n- Pricing\n"]])).length, 0);
  eq("a list whose short lead-in shares one generic word with the requirement is a different list", narrowedLists(doc(req("REQ-001", "None.", "Fields become mandatory for the customer, job site and PO number when a condition is met.")),
    new Map([["inputs/billing.md", "Examples\n\nAgreement Screen\n\nVisible Fields:\n\n- Customer\n- Job Site\n- PO Number\n- Billing Method\n"]])).length, 0);
  eq("nothing is said when there is nothing", formatNarrowedLists([]), null);
  eq("what is said names the items left out", /not named: Pricing/.test(formatNarrowedLists(narrow) ?? ""), true);
}

console.log(`source gaps — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
