/**
 * Pins the after-the-fact checks in src/verify.ts.
 *
 *   npm test
 *
 * Their whole value is where they draw the line — flag "this is exploitable", stay
 * quiet on "this would be exploitable if the route is reachable". Cases marked FLAG
 * are the shapes that scored Precision at 1.12/3 in the Round 2 black-box report
 * (28 July 2026); several are verbatim from real runs against gin.
 */
import {
  unprovenClaims,
  unsavedArtifactClaims,
  unqualifiedCompatibility,
  missingInputGate,
} from "../src/verify.js";

let failures = 0;
const fail = (msg: string) => { console.error(msg); failures++; };

// --- claims about a running system ----------------------------------------

/** Asserted as observed fact — no tool here could have seen any of these. */
const FLAG = [
  "Authentication is disabled and the service is deployed without any gate.",
  "This is a confirmed compromise of the credential store.",
  "All 14 tests pass and the project compiles cleanly.",
  "Coverage is 78% across the solution.",
  "The endpoint is actively exploited by unauthenticated callers.",
  "Secrets are live in the production environment.",
  "Attackers can currently reach this route.",
  "The build succeeds with no warnings.",
  // Both observed verbatim from the security agent against gin, 28 July 2026.
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

for (const s of FLAG) if (unprovenClaims(s).length === 0) fail(`MISSED   | ${s}`);
for (const s of QUIET) if (unprovenClaims(s).length > 0) fail(`FALSE +  | ${s}`);

// --- artifacts claimed as saved that were never written -------------------

/** [answer text, what save_artifact actually wrote, phantoms expected] */
const SAVED: Array<[string, string[], number]> = [
  ["I have saved the threat model to `threat-model.md`.", [], 1],
  ["The workflow was written to `.github/workflows/ci.yml`.", [], 1],
  // A full path from the tool must match a bare filename in the prose.
  ["Saved to `brd-checkout.md`.", ["C:/repo/artifacts/brd-checkout.md"], 0],
  ["Report persisted as `reviews/api-review.md`.", ["/srv/artifacts/reviews/api-review.md"], 0],
  // Proposals and observations are not save claims.
  ["I propose creating `adr-003.md` with the following content.", [], 0],
  ["The pipeline is defined in `.github/workflows/ci.yml`.", [], 0],
  ["`utils.go` was created in an earlier commit.", [], 0],
  // A list of targets must be checked in full, not just the first.
  ["Two artifacts saved: `a.md` and `b.md`.", ["/x/a.md"], 1],
  ["Saved: `a.md`, `b.md` and `c.md`.", ["/x/a.md", "/x/c.md"], 1],
  // The subject of the review is not the save target.
  ["Saved the review of `Foo.cs` to `review.md`.", ["/x/review.md"], 0],
];

for (const [text, saved, expected] of SAVED) {
  const got = unsavedArtifactClaims(text, new Set(saved)).length;
  if (got !== expected) fail(`SAVED    | expected ${expected} phantom(s), got ${got} | ${text}`);
}

// --- compatibility verdicts without a kind --------------------------------

/** Tells the reader a change is safe to take, without saying safe in which sense. */
const COMPAT_FLAG = [
  "This change is backward compatible.",
  "The refactor is non-breaking.",
  "These additions are purely additive.",
  "There are no breaking changes in this release.",
  "The new client is a drop-in replacement.",
  "`LegacyHelper` is unused and safe to remove.",
  "Renaming the property has no impact on consumers.",
  // SPV-01 missed exactly this: source unchanged, compiled callers broken.
  "Adding the optional parameter is not a breaking change.",
];

/** Names a kind, or admits it was not verified. Either answers the question. */
const COMPAT_QUIET = [
  "Source-compatible; binary compatibility is broken by the added parameter (Observed).",
  "Backward compatible at the source level only — compiled callers must be rebuilt.",
  "Purely additive to the wire schema; the on-disk format is unchanged.",
  "Safe to remove: no reflection, DI registration or configuration binding references it.",
  "This should be backward compatible, but nothing was rebuilt to confirm it (Unverified).",
  "The package bump is non-breaking under semver, though the transitive graph shifts.",
  "No impact on consumers of the serialized contract; the property name is unchanged.",
  // Reporting somebody else's claim, not making one.
  "The vendor documents the upgrade as a drop-in replacement for the previous major.",
  // The claim requiring reconciliation, called out by name in the report.
  "Switching DateTime to DateTimeOffset is a schema change requiring a migration.",
  // Visibility is the compatibility answer for a removal: nothing outside the
  // package can reference an unexported symbol. Observed from a real dead-code run.
  "These are unexported and have no production callers, so they are safe to remove.",
  "`LegacyHelper` is private and safe to delete.",
];

for (const s of COMPAT_FLAG) if (unqualifiedCompatibility(s).length === 0) fail(`COMPAT ? | ${s}`);
for (const s of COMPAT_QUIET) if (unqualifiedCompatibility(s).length > 0) fail(`COMPAT + | ${s}`);

// --- the prerequisite gate ------------------------------------------------

/** [label, tool, names that failed to read, successful reads, should it block] */
const GATE: Array<[string, string, string[], number, boolean]> = [
  ["required input missing, nothing else read", "save_artifact", ["brd-payments.md"], 0, true],
  ["several inputs missing", "save_artifact", ["brd.md", "adr-001.md"], 0, true],
  // Guessed a name, missed, then found the real one — the correct recovery.
  ["missed then recovered via list_artifacts", "save_artifact", ["brd-checkout.md"], 1, false],
  ["nothing was ever missing", "save_artifact", [], 0, false],
  ["nothing missing, plenty read", "save_artifact", [], 3, false],
  // Only artifact creation is gated; reading and searching stay open so the agent
  // can still investigate and explain what is missing.
  ["reading is never gated", "read_file", ["brd.md"], 0, false],
  ["searching is never gated", "search_code", ["brd.md"], 0, false],
  ["golden reads are never gated", "golden_read", ["brd.md"], 0, false],
];

for (const [label, tool, failed, ok, shouldBlock] of GATE) {
  const blocked = missingInputGate(tool, new Set(failed), ok) !== null;
  if (blocked !== shouldBlock) {
    fail(`GATE     | ${label}: expected ${shouldBlock ? "block" : "allow"}, got ${blocked ? "block" : "allow"}`);
  }
}

// The block text has to tell the agent how to get out of it, or it just retries.
const msg = missingInputGate("save_artifact", new Set(["brd.md"]), 0) ?? "";
if (!msg.includes("BLOCKED")) fail("GATE     | block message does not say BLOCKED");
if (!msg.includes("list_artifacts")) fail("GATE     | block message does not name the way out");
if (!msg.includes("brd.md")) fail("GATE     | block message does not name the missing input");

console.log(
  `${FLAG.length} must-flag, ${QUIET.length} must-stay-quiet, ` +
  `${COMPAT_FLAG.length + COMPAT_QUIET.length} compatibility, ` +
  `${SAVED.length} save-claim, ${GATE.length} gate cases — ${failures} failure(s)`
);
process.exit(failures ? 1 : 0);
