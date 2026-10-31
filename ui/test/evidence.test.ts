/**
 * Pins the evidence ledger in src/evidence.ts.
 *
 *   npm test
 *
 * What matters is where it refuses to overclaim: a record with no file list is
 * "unscoped", not "fresh"; a claim citing nothing is "unsupported"; an invented
 * evidence ID is flagged. Freshness is exercised against real files, since a hash
 * comparison that is only ever mocked proves nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EvidenceStore,
  claimStatus,
  evidenceFilesFor,
  freshnessOf,
  hashFile,
  isErrorResult,
  safeJoin,
  snapshotFiles,
  summarizeArgs,
  unknownEvidenceCitations,
  type Freshness,
} from "../src/evidence.js";

let failures = 0;
const fail = (msg: string) => { console.error(msg); failures++; };
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want))
    fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edd-"));
const root = path.join(tmp, "repo");
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");

// --- paths ------------------------------------------------------------------
eq("safeJoin inside", safeJoin(root, "src/a.ts"), path.join(root, "src", "a.ts"));
eq("safeJoin escape", safeJoin(root, "../outside.txt"), null);
eq("safeJoin deep escape", safeJoin(root, "src/../../x"), null);

// --- hashing ----------------------------------------------------------------
const h1 = hashFile(root, "src/a.ts");
if (!h1 || h1 === "absent") fail("hashFile should hash an existing file");
eq("hashFile absent", hashFile(root, "src/nope.ts"), "absent");
eq("hashFile escaping path", hashFile(root, "../etc/passwd"), null);
eq("hashFile directory", hashFile(root, "src"), null);

// --- freshness against real files --------------------------------------------
const files = snapshotFiles(root, ["src/a.ts", "src/a.ts", "src/new.ts"]);
eq("snapshot dedupes and records absence", files.map((f) => f.path), ["src/a.ts", "src/new.ts"]);
eq("fresh when untouched", freshnessOf({ files }, root), "fresh");

fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2;\n");
eq("stale after the file changes", freshnessOf({ files }, root), "stale");

fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
eq("fresh again when content is restored", freshnessOf({ files }, root), "fresh");

fs.writeFileSync(path.join(root, "src", "new.ts"), "x");
eq("stale when a recorded-absent file appears", freshnessOf({ files }, root), "stale");

eq("no file list is unscoped, never fresh", freshnessOf({ files: [] }, root), "unscoped");

// --- which files an observation covers ---------------------------------------
eq("read_file takes the resolved path from the header",
  evidenceFilesFor("read_file", { path: "a.ts" }, "# `src/a.ts` (lines 1-1 of 1)\n```ts\n"), ["src/a.ts"]);
eq("read_file with no header covers nothing", evidenceFilesFor("read_file", { path: "a.ts" }, "weird"), []);
eq("propose_file_change covers its target",
  evidenceFilesFor("propose_file_change", { targetPath: "src/a.ts", content: "x" }, "Proposed change"), ["src/a.ts"]);
eq("search is unscoped", evidenceFilesFor("search_code", { query: "x" }, "# 1 match"), []);

// --- what counts as an observation -------------------------------------------
for (const t of ["ERROR: boom", "Refused: no", "BLOCKED — nope", "Nothing to propose: same", "Artifact not found: x"])
  if (!isErrorResult(t)) fail(`should not be recorded: ${t}`);
for (const t of ["# `a.ts` (lines 1-2 of 2)", "Proposed change to `a.ts`", "# 3 match(es)"])
  if (isErrorResult(t)) fail(`should be recorded: ${t}`);

// --- args never carry file content --------------------------------------------
const big = "x".repeat(5000);
const summary = summarizeArgs({ targetPath: "src/a.ts", kind: "modify", content: big });
if (summary.length > 300) fail("summarizeArgs must cap its length");
if (summary.includes("x".repeat(100))) fail("summarizeArgs must not embed long content");

// --- claim status -------------------------------------------------------------
const fr = (o: Record<string, Freshness>) => new Map(Object.entries(o));
eq("no evidence is unsupported", claimStatus({ evidence: [] }, fr({})), "unsupported");
eq("all fresh is supported", claimStatus({ evidence: ["EV-1", "EV-2"] }, fr({ "EV-1": "fresh", "EV-2": "fresh" })), "supported");
eq("unscoped does not make it stale", claimStatus({ evidence: ["EV-1"] }, fr({ "EV-1": "unscoped" })), "supported");
eq("one stale makes the claim stale", claimStatus({ evidence: ["EV-1", "EV-2"] }, fr({ "EV-1": "fresh", "EV-2": "stale" })), "stale");

// --- citation check -----------------------------------------------------------
const known = new Set(["EV-0000000A", "CL-0000000B"]);
eq("known ids pass", unknownEvidenceCitations("see EV-0000000A and CL-0000000B", known), []);
eq("invented id is flagged", unknownEvidenceCitations("per EV-DEADBEEF the code is safe", known), ["EV-DEADBEEF"]);
eq("duplicates collapse", unknownEvidenceCitations("EV-DEADBEEF, EV-DEADBEEF", known), ["EV-DEADBEEF"]);
eq("lowercase prose is not an id", unknownEvidenceCitations("the ev-deadbeef thing", known), []);
eq("a word that merely looks similar is not an id", unknownEvidenceCitations("REV-DEADBEEF1", known), []);

// --- the store: persistence, project scoping, resilience ---------------------
const dir = path.join(tmp, "ledger");
const store = new EvidenceStore(dir);
const rec = store.addObservation({
  runId: "run-1", projectId: "p1", agent: "code-reviewer", tool: "read_file",
  args: "path=a.ts", outputHash: "h", excerpt: "e", files, commit: "abc",
});
if (!/^EV-[0-9A-F]{8}$/.test(rec.id)) fail(`bad evidence id: ${rec.id}`);
const claim = store.addClaim({
  runId: "run-1", projectId: "p1", agent: "code-reviewer",
  statement: "a is 1", disproof: "a.ts exports something else", risk: "low", evidence: [rec.id],
});
if (!/^CL-[0-9A-F]{8}$/.test(claim.id)) fail(`bad claim id: ${claim.id}`);

eq("same project can resolve its evidence", store.getEvidence(rec.id, "p1")?.id, rec.id);
eq("another project cannot cite it", store.getEvidence(rec.id, "p2"), undefined);
eq("known ids are per project", [...store.knownIds("p2")], []);

// A fresh process reading the same file sees what was written.
const reopened = new EvidenceStore(dir);
eq("reload keeps evidence", reopened.getEvidence(rec.id, "p1")?.tool, "read_file");
eq("reload keeps claims", reopened.forProject("p1").claims.map((c) => c.id), [claim.id]);

// A crash mid-append leaves a torn line; it must not take the ledger with it.
fs.appendFileSync(path.join(dir, "evidence.jsonl"), '{"t":"e","r":{"id":"EV-TORN');
const afterTear = new EvidenceStore(dir);
eq("a torn last line loses only itself", afterTear.getEvidence(rec.id, "p1")?.id, rec.id);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`evidence ledger — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
