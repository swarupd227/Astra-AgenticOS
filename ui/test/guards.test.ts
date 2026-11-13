/**
 * Pins the guard against destructive saves (src/guards.ts).
 *
 *   npm test
 */
import { contentKey, countCitations, destructiveSave, implausiblyShort } from "../src/guards.js";

let failures = 0;
const fail = (m: string) => { console.error(m); failures++; };
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(want === got ? got : got)}`);
};
const refused = (o: Parameters<typeof destructiveSave>[0]) => destructiveSave(o) !== null;

// The incident: 161 characters over a 148,929-character document.
eq("the incident is refused", refused({ kind: "document", newLen: 161, prevLen: 148929, name: "brd.md" }), true);
{
  const msg = destructiveSave({ kind: "document", newLen: 161, prevLen: 148929, name: "brd.md" }) ?? "";
  if (!msg.includes("148,929") || !msg.includes("161")) fail("the refusal should state both sizes");
  if (!msg.includes("exactly the same content again")) fail("the refusal should say how to override it");
  if (!msg.includes("brd.md.vN")) fail("the refusal should say the earlier version is kept");
  if (!msg.startsWith("BLOCKED")) fail("the refusal should say nothing was saved");
}

eq("a first save replaces nothing", refused({ kind: "document", newLen: 50, prevLen: null, name: "a.md" }), false);
eq("an ordinary rewrite of similar size passes", refused({ kind: "document", newLen: 140000, prevLen: 148929, name: "a.md" }), false);
eq("a document that grows passes", refused({ kind: "document", newLen: 160000, prevLen: 148929, name: "a.md" }), false);
eq("halving a long document is allowed", refused({ kind: "document", newLen: 75000, prevLen: 148929, name: "a.md" }), false);
eq("cutting a long document to under half is refused", refused({ kind: "document", newLen: 70000, prevLen: 148929, name: "a.md" }), true);
eq("a short document may be rewritten shorter freely", refused({ kind: "document", newLen: 500, prevLen: 3000, name: "a.md" }), false);
eq("but a tiny result over a 1,000+ character document is refused even if the old one is short",
  refused({ kind: "document", newLen: 150, prevLen: 1200, name: "a.md" }), true);

eq("a section rewritten to a fifth of its size is refused", refused({ kind: "section", newLen: 400, prevLen: 3000, name: "brd.md" }), true);
eq("a section trimmed by a third passes", refused({ kind: "section", newLen: 2000, prevLen: 3000, name: "brd.md" }), false);
eq("a small section can shrink freely", refused({ kind: "section", newLen: 100, prevLen: 900, name: "brd.md" }), false);

// Losing every citation is refused even when the size is similar — the case the content checks cannot see.
{
  const same = { kind: "document" as const, newLen: 140000, prevLen: 148929, name: "brd.md" };
  eq("same size, all citations stripped from a cited document: refused", refused({ ...same, prevCitations: 40, newCitations: 0 }), true);
  const msg = destructiveSave({ ...same, prevCitations: 40, newCitations: 0 }) ?? "";
  if (!msg.includes("40") || !msg.includes("nothing to check")) fail("the refusal should say how many citations were lost and why it matters");
  eq("a few citations remaining is an ordinary rewrite", refused({ ...same, prevCitations: 40, newCitations: 12 }), false);
  eq("a document that never had many citations is not held to this", refused({ ...same, prevCitations: 3, newCitations: 0 }), false);
  eq("unknown citation counts change nothing", refused(same), false);
  eq("a first save is never refused for lacking citations", refused({ ...same, prevLen: null, prevCitations: 0, newCitations: 0 }), false);
  eq("a section that loses all its citations is refused too",
    refused({ kind: "section", newLen: 2500, prevLen: 3000, name: "brd.md § Requirements", prevCitations: 9, newCitations: 0 }), true);
  eq("countCitations counts both kinds", countCitations("a GLD-REF-030@1 and inputs/spec.md and gld-fs-001"), 3);
  eq("no citations counts zero", countCitations("plain text"), 0);
}

eq("a repeat of the same content has the same key", contentKey("a.md", "same text"), contentKey("a.md", "same text"));
eq("different content has a different key", contentKey("a.md", "one") === contentKey("a.md", "two"), false);
eq("the same content in another file has a different key", contentKey("a.md", "x") === contentKey("b.md", "x"), false);

eq("a 161-character document is flagged as implausibly short", (implausiblyShort(161) ?? "").includes("161 characters"), true);
eq("a real document is not", implausiblyShort(20000), null);
eq("the short-document note says where the earlier version is", (implausiblyShort(10) ?? "").includes(".vN"), true);

console.log(`destructive-save guard — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
