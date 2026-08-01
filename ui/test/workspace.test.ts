/**
 * Pins what survives an upload.
 *
 *   npm run test:workspace   (also run by `npm test`)
 *
 * The stakes are lopsided. Leaving build output behind wastes space; deleting a source
 * folder by mistake hides code from every agent while the run still looks successful —
 * so the trap cases below matter more than the happy path.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pruneUnindexed, isNeverIndexed, unzipExcludeArgs, NEVER_INDEXED } from "../src/workspace.js";

let failures = 0;
const fail = (msg: string) => { console.error(msg); failures++; };

// A .NET solution shaped the way the 400 MB upload almost certainly was.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "prune-"));
const write = (rel: string, size: number) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "x".repeat(size));
};

const SOURCE = [
  "src/Basket.API/Basket.cs",
  "src/Web/ClientApp/src/app.ts",
  "tests/Basket.UnitTests/BasketTests.cs",
  // Traps: a *file* named bin, and a folder whose name merely contains "bin".
  "src/Basket.API/bin.cs",
  "src/Cabinet/Service.cs",
  // A folder that starts with an ignored name but is not it.
  "src/outbox/Publisher.cs",
];
const JUNK = [
  "src/Basket.API/bin/Debug/Basket.dll",
  "src/Basket.API/obj/project.assets.json",
  "src/Web/ClientApp/node_modules/react/index.js",
  "src/Web/ClientApp/dist/bundle.js",
  "packages/Newtonsoft.Json/lib.dll",
  ".git/objects/ab/cdef",
  "tests/Basket.UnitTests/TestResults/coverage.xml",
];

SOURCE.forEach((f) => write(f, 100));
JUNK.forEach((f) => write(f, 5000));

const result = pruneUnindexed(root);

const survivors: string[] = [];
(function walk(d: string) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else survivors.push(path.relative(root, f).split(path.sep).join("/"));
  }
})(root);

for (const s of SOURCE) if (!survivors.includes(s)) fail(`DELETED SOURCE | ${s}`);
for (const j of JUNK) if (survivors.includes(j)) fail(`KEPT JUNK      | ${j}`);
if (result.bytes !== JUNK.length * 5000) fail(`BYTES          | expected ${JUNK.length * 5000}, got ${result.bytes}`);

fs.rmSync(root, { recursive: true, force: true });

// Whole-segment matching, not substring.
for (const [name, expected] of [
  ["bin", true], ["obj", true], ["node_modules", true], [".git", true],
  ["bin.cs", false], ["Cabinet", false], ["outbox", false], ["rebuild", false], ["distribution", false],
] as Array<[string, boolean]>) {
  if (isNeverIndexed(name) !== expected) fail(`MATCH          | ${name}: expected ${expected}`);
}

// Every ignored directory needs a root-level and an any-depth pattern.
const args = unzipExcludeArgs();
if (args[0] !== "-x") fail("EXCLUDE        | first arg must be -x");
if (args.length !== NEVER_INDEXED.length * 2 + 1) fail(`EXCLUDE        | expected ${NEVER_INDEXED.length * 2 + 1} args, got ${args.length}`);
for (const d of NEVER_INDEXED) {
  if (!args.includes(`${d}/*`)) fail(`EXCLUDE        | missing root pattern for ${d}`);
  if (!args.includes(`*/${d}/*`)) fail(`EXCLUDE        | missing nested pattern for ${d}`);
}

console.log(
  `${SOURCE.length} source kept, ${JUNK.length} junk removed ` +
  `(${result.removed} folders, ${(result.bytes / 1024).toFixed(0)} KB), ` +
  `${NEVER_INDEXED.length} ignored dirs — ${failures} failure(s)`
);
process.exit(failures ? 1 : 0);
