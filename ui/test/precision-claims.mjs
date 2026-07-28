/**
 * Regression test for the unproven-claim detector.
 *
 *   node test/precision-claims.mjs
 *
 * The three regexes in server.ts *are* the feature, and their value is entirely in
 * where they draw the line — flag "this is exploitable", stay quiet on "this would be
 * exploitable if the route is reachable". A copy of them here would drift from the
 * real ones within a week, so this reads them straight out of the source.
 *
 * Cases marked FLAG are taken from the Round 2 black-box report (28 July 2026): the
 * sentences below are the shapes that scored Precision at 1.12/3.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "src", "server.ts"), "utf8");

function regexFromSource(name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*\\n?\\s*(/.*/[gi]*);`));
  if (!m) throw new Error(`Could not find ${name} in server.ts — did it get renamed?`);
  return eval(m[1]);
}

const RUNTIME_CLAIM = regexFromSource("RUNTIME_CLAIM");
const MEASURED_CLAIM = regexFromSource("MEASURED_CLAIM");
const HEDGED = regexFromSource("HEDGED");

function unprovenClaims(text) {
  const found = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim();
    if (!s || s.length > 400) continue;
    if (HEDGED.test(s)) continue;
    RUNTIME_CLAIM.lastIndex = 0;
    MEASURED_CLAIM.lastIndex = 0;
    if (RUNTIME_CLAIM.test(s) || MEASURED_CLAIM.test(s)) {
      found.push(s);
      if (found.length >= 5) break;
    }
  }
  return found;
}

/** Asserted as observed fact — the platform has no tool that could have seen these. */
const FLAG = [
  "Authentication is disabled and the service is deployed without any gate.",
  "This is a confirmed compromise of the credential store.",
  "All 14 tests pass and the project compiles cleanly.",
  "Coverage is 78% across the solution.",
  "The endpoint is actively exploited by unauthenticated callers.",
  "Secrets are live in the production environment.",
  "Attackers can currently reach this route.",
  "The build succeeds with no warnings.",
  // Both observed verbatim in real runs against gin, 28 July 2026.
  "three additional High vulnerabilities that are all exploitable on the wire",
  "### Critical Findings (Exploitable in Production)",
];

/** Correctly qualified, or plainly about static facts. Flagging these would be noise. */
const QUIET = [
  "If deployed with this config, authentication would be disabled (Inferred).",
  "14 test methods exist (Observed). Nothing was executed, so pass/fail is Unverified.",
  "This could be exploited if the route is reachable unauthenticated (Unverified).",
  "`coverlet.collector` is absent, so no coverage figure can be produced.",
  "The service appears to read Auth__Enabled at startup.",
  "I propose adding a test that compiles cleanly under xUnit.",
  "No tests were run during this review.",
  "The deployment pipeline is defined in .github/workflows/ci.yml.",
  "We recommend a change that compiles cleanly.",
  "The team should verify all tests pass before merge.",
  "Exploitable only if a consumer calls RunTLS on an untrusted network (Unverified).",
  "This would be exploitable when the handler is reachable.",
];

let failures = 0;
for (const s of FLAG) {
  if (unprovenClaims(s).length === 0) { console.error(`MISSED   | ${s}`); failures++; }
}
for (const s of QUIET) {
  if (unprovenClaims(s).length > 0) { console.error(`FALSE +  | ${s}`); failures++; }
}

console.log(`${FLAG.length} must-flag, ${QUIET.length} must-stay-quiet — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
