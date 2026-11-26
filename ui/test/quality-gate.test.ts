/**
 * Pins the quality gate other tools call (src/quality-gate.ts and src/quality-mcp.ts): which files it reads, how it
 * reads citations of them, what it reports, and that the server and the command answer.
 *
 *   npm run test:gate
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { asInputs, checkDocument, compareSources, reviewInstructions } from "../src/quality-gate.js";

let failures = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); failures++; }
};
const throws = (label: string, fn: () => unknown, like: RegExp) => {
  try { fn(); eq(label, "no error", String(like)); } catch (e) { eq(label, like.test((e as Error).message), true); }
};

const base = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
const root = path.join(base, "repo");
const put = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), text); };
fs.writeFileSync(path.join(base, "secret.md"), "outside the repository");

const SPEC = ["# Rentals", "", "## Reservations", "",
  "### Fleet Commitment", "", "A confirmed reservation should commit fleet capacity for the requested rental period.", "",
  "### Return Capture", "", "The return should record the return date and the equipment condition.", "",
  "### Damage Assessment", "", "Damage should be assessed when equipment is returned from the customer.", ""].join("\n");
put("docs/spec.md", SPEC);
const req = (n: number, name: string, statement: string, cite: string, quote = statement) =>
  `#### REQ-00${n} — ${name}\n\n**Requirement Statement:** ${statement}\n\n**Source Reference:** ${cite} — Reservations › ${name}: “${quote}”\n\n**Priority:** Not specified in source.\n\n**Dependencies:** Not Specified.\n\n**Open Questions:** None identified in source.\n\n`;
const good = [
  req(1, "Fleet Commitment", "A confirmed reservation should commit fleet capacity for the requested rental period.", "`docs/spec.md`"),
  req(2, "Return Capture", "The return should record the return date and the equipment condition.", "`spec.md`"),
  req(3, "Damage Assessment", "Damage should be assessed when equipment is returned from the customer.", "`inputs/spec.md`"),
];
put("brd.md", `# BRD\n\n## Requirements\n\n${good.join("")}`);
put("brd-wrong.md", `# BRD\n\n## Requirements\n\n${[good[0], good[1],
  req(3, "Damage Assessment", "The depot supervisor shall approve every refund within two business days of the claim.", "`docs/spec.md`")].join("")}`);

// --- citations of files anywhere in the repository ---------------------------------------------
{
  const r = asInputs("a `docs/spec.md` b `spec.md` c `inputs/spec.md` d ./docs/spec.md e other-spec.md", ["docs/spec.md"]);
  eq("the path, the file name and the inputs name are all read as one source", r.doc, "a `inputs/spec.md` b `inputs/spec.md` c `inputs/spec.md` d inputs/spec.md e other-spec.md");
  eq("a name with spaces is made citable", asInputs("see `My Spec.md`", ["My Spec.md"]).doc, "see `inputs/My-Spec.md`");
  throws("two sources with one name are refused", () => asInputs("", ["a/spec.md", "b/spec.md"]), /both cited as/);
}

// --- what is reported -----------------------------------------------------------------------------
{
  const ok = checkDocument({ root }, { document: "brd.md", sources: ["docs"] });
  eq("a faithful document has no findings", ok.findings, []);
  eq("and says what was read and what was not run", /3 requirements read against 1 source/.test(ok.text) && /Not run here/.test(ok.text), true);
  const bad = checkDocument({ root }, { document: "brd-wrong.md", sources: ["docs/spec.md"] });
  eq("an invented requirement is found", bad.findings.length > 0, true);
  eq("the item it displaced is named", bad.text.includes("Damage Assessment"), true);
  put("stub.md", "# BRD\n\nNothing here.");
  eq("a document with no requirements does not pass", checkDocument({ root }, { document: "stub.md", sources: ["docs"] }).findings.some((f) => /Fewer than three/.test(f)), true);
  put("gld.md", `${fs.readFileSync(path.join(root, "brd.md"), "utf8")}\nPer GLD-STD-001@1.\n`);
  eq("a Golden citation that cannot be read is said, not passed", checkDocument({ root }, { document: "gld.md", sources: ["docs"] }).findings.some((f) => /could not be read/.test(f)), true);
}

// --- only the repository is read ------------------------------------------------------------------
{
  throws("a source outside the folder is refused", () => checkDocument({ root }, { document: "brd.md", sources: ["../secret.md"] }), /outside/);
  throws("a task file outside the folder is refused", () => checkDocument({ root }, { document: "brd.md", sources: ["docs"], taskFile: path.join(base, "secret.md") }), /outside/);
  throws("a document cannot be its own source", () => checkDocument({ root }, { document: "brd.md", sources: ["brd.md"] }), /also listed/);
  throws("a Word file is refused with what to do", () => { put("a.docx", "x"); checkDocument({ root }, { document: "brd.md", sources: ["a.docx"] }); }, /convert/);
  throws("a missing file is named", () => checkDocument({ root }, { document: "brd.md", sources: ["nope.md"] }), /nope\.md does not exist/);
}

eq("sources can be compared before writing", compareSources({ root }, { sources: ["docs"] }).startsWith("Compared 1 sources"), true);
eq("the reviewer's brief asks for an independent reader", /did not write/.test(reviewInstructions()) && !/report_review|in results if/.test(reviewInstructions()), true);

// --- the command and the server --------------------------------------------------------------------
const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(ui, "node_modules", "tsx", "dist", "cli.mjs");
const entry = path.join(ui, "src", "quality-mcp.ts");
// Not spawnSync: a tsx child reports to its parent, which a blocked parent never answers.
const run = (args: string[]) => new Promise<number>((done) => {
  execFile(process.execPath, [tsx, entry, ...args], { env: { ...process.env, GATE_ROOT: root }, timeout: 60_000 }, (e) => done(e ? Number((e as { code?: number }).code ?? -1) : 0));
});
eq("the command exits 0 with no findings", await run(["check", "brd.md", "docs"]), 0);
eq("1 with findings", await run(["check", "brd-wrong.md", "docs"]), 1);
eq("2 when it cannot run", await run(["check", "brd.md", "nope.md"]), 2);
eq("2 when called wrongly", await run(["check", "brd.md"]), 2);

const client = new Client({ name: "gate-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [tsx, entry], env: { ...(process.env as Record<string, string>), GATE_ROOT: root } }));
eq("the server lists its tools", (await client.listTools()).tools.map((t) => t.name), ["check_document", "compare_sources", "review_instructions"]);
const answer = await client.callTool({ name: "check_document", arguments: { document: "brd.md", sources: ["docs"] } });
eq("and checks a document", (answer.content as { text: string }[])[0].text.includes("no findings"), true);
const refused = await client.callTool({ name: "check_document", arguments: { document: "brd.md", sources: ["../secret.md"] } });
eq("and answers a refusal as an error", refused.isError, true);
await client.close();

fs.rmSync(base, { recursive: true, force: true });
console.log(`quality gate — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
