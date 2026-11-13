/**
 * Pins how a document is composed from sections (src/sections.ts).
 *
 *   npm test
 */
import { SectionedDoc, sectionKey } from "../src/sections.js";

let failures = 0;
const fail = (m: string) => { console.error(m); failures++; };
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

{
  const d = new SectionedDoc();
  eq("a new section is not a replacement", d.set("Business Objectives", "## Business Objectives\n\nReduce credit risk."), false);
  d.set("Success Criteria", "## Success Criteria\n\nNot specified in source.");
  d.set("Requirements", "## Requirements\n\nREQ-001 The system shall hold a credit limit.");
  eq("sections come out in the order they were written", d.titles(), ["Business Objectives", "Success Criteria", "Requirements"]);
  eq("the composed document is the sections in order, one blank line apart",
    d.compose(),
    "## Business Objectives\n\nReduce credit risk.\n\n## Success Criteria\n\nNot specified in source.\n\n## Requirements\n\nREQ-001 The system shall hold a credit limit.\n");
}

{
  const d = new SectionedDoc();
  d.set("A", "## A\n\none"); d.set("B", "## B\n\ntwo"); d.set("C", "## C\n\nthree");
  eq("rewriting a section reports a replacement", d.set("B", "## B\n\ntwo, corrected"), true);
  eq("…and leaves it where it was", d.titles(), ["A", "B", "C"]);
  eq("only the rewritten section changed", d.text("B"), "## B\n\ntwo, corrected");
  eq("the others are untouched", [d.text("A"), d.text("C")], ["## A\n\none", "## C\n\nthree"]);
}

{
  const d = new SectionedDoc();
  d.set("Introduction", "## Introduction\n\nx"); d.set("Appendix", "## Appendix\n\ny");
  d.set("Scope", "## Scope\n\nz", "Introduction");
  eq("a section can be inserted after a named one", d.titles(), ["Introduction", "Scope", "Appendix"]);
  d.set("Notes", "## Notes\n\nn", "No Such Section");
  eq("an unknown anchor appends rather than failing", d.titles(), ["Introduction", "Scope", "Appendix", "Notes"]);
}

{
  const d = new SectionedDoc();
  d.set("3.1 Billing Methods", "REQ-001 Weekly, Monthly and 28 Day billing.");
  eq("content without a heading gets one from the title", d.text("3.1 Billing Methods"), "## 3.1 Billing Methods\n\nREQ-001 Weekly, Monthly and 28 Day billing.");
  d.set("Title", "# Business Requirements Document\n\nVersion 1");
  eq("content that already has a heading, at any level, is not given another", d.text("Title"), "# Business Requirements Document\n\nVersion 1");
  d.set("Padded", "## Padded\n\ntext\n\n\n   ");
  eq("trailing whitespace is trimmed so sections join cleanly", d.text("Padded"), "## Padded\n\ntext");
}

{
  const d = new SectionedDoc();
  d.set("Business Objectives", "## Business Objectives\n\none");
  eq("titles match regardless of case and punctuation", d.has("business  objectives!"), true);
  eq("numbering is part of the title — 3.1 and 6.1 are different sections", d.has("3.1 Billing") || d.has("6.1 Billing"), false);
  d.set("3.1 Billing", "x"); d.set("6.1 Billing", "y");
  eq("two numbered sections with the same name coexist", d.titles().filter((t) => /Billing/.test(t)), ["3.1 Billing", "6.1 Billing"]);
  eq("a replacement matches the title ignoring case", d.set("business objectives", "## Business Objectives\n\ntwo"), true);
  eq("sectionKey ignores punctuation and case", sectionKey("  Open  Questions: "), "open questions");
}

eq("an empty document composes to a single newline", new SectionedDoc().compose(), "\n");

console.log(`sectioned documents — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
