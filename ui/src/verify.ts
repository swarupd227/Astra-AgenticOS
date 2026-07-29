/**
 * After-the-fact checks on what an agent said, and one gate on what it may do.
 *
 * These exist because asking nicely stopped working. The operating contract has told
 * agents to label inference and to stop on a missing prerequisite since the July 24
 * report; the July 28 report was scored against a build where it did, and Precision
 * still came out at 1.12 out of 3. What does hold is the citation check, and its shape
 * is the reason: a factual comparison made after the fact, which no amount of confident
 * wording gets past.
 *
 * Everything here is pure so it can be tested directly — see test/precision-claims.mjs.
 */

/**
 * Claims about a running system.
 *
 * Every tool in this platform is static: it reads files, searches text, walks git
 * history, runs a linter. Nothing starts the application, reaches a deployed
 * environment, compiles, or runs a test. So an unhedged sentence asserting live
 * behaviour, an active compromise, or a test result is not a judgement call — it
 * describes something no tool in the run could have seen.
 */
export const RUNTIME_CLAIM =
  /\b(?:is|are|was|were|has been|have been)\s+(?:currently\s+)?(?:deployed|live|running in production|actively exploited|compromised|breached)\b|\bin (?:the )?(?:live|production) environment\b|\bconfirmed compromise\b|\battackers? (?:can|are) (?:currently|now)\b|\bexploitable\b/gi;

export const MEASURED_CLAIM =
  /\b(?:all|the)\s+\d*\s*tests?\s+(?:pass|passed|are passing)\b|\b\d+\s+tests?\s+(?:pass|passed|fail|failed)\b|\bcompiles?\s+(?:cleanly|successfully|without errors)\b|\bbuild\s+succeed(?:s|ed)\b|\bcoverage\s+(?:is|of|at)\s+\d+(?:\.\d+)?\s*%/gi;

/** Words showing the writer already marked the claim as not-observed. */
export const HEDGED =
  /\b(?:unverified|inferred|inference|assumption|assumed|not verified|cannot confirm|could not verify|unable to verify|would|could|may|might|appears|suggests|hypothetical|if deployed|if enabled|once deployed|expected to|should|propos(?:e|es|ed|ing)|recommend(?:s|ed|ing)?|plans? to)\b/i;

/** Sentences that split a paragraph — the unit a qualifier has to appear in. */
const SENTENCES = /(?<=[.!?])\s+|\n+/;

/**
 * Runtime or measured assertions carrying no qualifier.
 *
 * Scanned per sentence, because a caveat three paragraphs away is exactly how static
 * config became "confirmed compromise" in CSA-01. A sentence carrying its own
 * qualifier is left alone: the goal is to force the precondition to be stated, not to
 * ban the vocabulary.
 */
export function unprovenClaims(text: string): string[] {
  const found: string[] = [];
  for (const raw of text.split(SENTENCES)) {
    const s = raw.trim();
    if (!s || s.length > 400) continue;      // long lines are tables or code, not assertions
    if (HEDGED.test(s)) continue;
    RUNTIME_CLAIM.lastIndex = 0;
    MEASURED_CLAIM.lastIndex = 0;
    if (RUNTIME_CLAIM.test(s) || MEASURED_CLAIM.test(s)) {
      found.push(s.replace(/\s+/g, " ").slice(0, 150));
      if (found.length >= 5) break;
    }
  }
  return found;
}

/**
 * Verdicts that tell a reader a change is safe to take.
 *
 * "Backward compatible" is five different questions wearing one coat. A method whose
 * signature is unchanged in source can still break every compiled caller; a field
 * renamed in a DTO breaks nothing at compile time and every persisted document at read
 * time. Round 2 marked this incomplete across SPV, DHA, DC, DEP and FVM — Spec
 * Validator missed public-API binary compatibility outright.
 */
export const COMPAT_VERDICT =
  /\b(?:backwards?[- ]compatible|non[- ]breaking|not a breaking change|no breaking changes|purely additive|additive[- ]only|drop[- ]in replacement|safe to (?:remove|delete)|no impact on (?:consumers|callers|clients))\b/i;

/**
 * Words that make such a verdict answerable: which compatibility, or — for a removal —
 * which of the ways a symbol stays reachable without a visible call site.
 */
export const COMPAT_KIND =
  /\b(?:source|binary|ABI|schema|serial(?:is|iz)(?:ation|ed|able)|wire|package|NuGet|npm|semver|migration|API surface|on[- ]disk|reflection|dependency injection|DI|config(?:uration)?[- ]bound|Activator|dynamic(?:ally)?|entry ?point|public API|(?:un)?exported|internal|private)\b/i;

/**
 * Reporting somebody else's compatibility claim is not making one. "The vendor
 * documents this as a drop-in replacement" is an accurate observation about the
 * documentation, and demanding a kind from it would punish exactly the sourcing we
 * want.
 */
export const ATTRIBUTED =
  /\b(?:documents?|documented|claims?|claimed|advertis(?:e|es|ed)|according to|per the|release notes|changelog|upstream says|states that)\b/i;

/**
 * Compatibility verdicts that never say which compatibility they mean.
 *
 * Naming a kind is enough to pass — this forces the question to be answered, it does
 * not judge the answer. A hedged verdict passes too: "should be source-compatible" is
 * already an admission that it was not verified.
 */
export function unqualifiedCompatibility(text: string): string[] {
  const found: string[] = [];
  for (const raw of text.split(SENTENCES)) {
    const s = raw.trim();
    if (!s || s.length > 400) continue;
    if (!COMPAT_VERDICT.test(s)) continue;
    if (COMPAT_KIND.test(s) || HEDGED.test(s) || ATTRIBUTED.test(s)) continue;
    found.push(s.replace(/\s+/g, " ").slice(0, 150));
    if (found.length >= 5) break;
  }
  return found;
}

/** Words that assert something was written down, not proposed or observed. */
export const SAVE_VERB = /\b(?:saved|persisted|stored|written)\b/i;

/**
 * A file named as the *target* of a save: after "to"/"as"/a colon, or continuing a
 * list. Anchoring to those connectors separates "saved the review of `Foo.cs` to
 * `review.md`" — one claim — from "saved: `a.md` and `b.md`", which is two.
 */
export const SAVE_TARGET =
  /(?:\bto\s+|\bas\s+|:\s*|,\s*|\band\s+)`([^`\n]+\.[A-Za-z0-9]{1,5})`/g;

/**
 * Artifacts the answer says it wrote that this run did not write.
 *
 * CI/CD scored 10 because a workflow was "reported as saved but was not retrievable",
 * so the controls inside it could never be reviewed. Saving itself works — save_artifact
 * versions the old copy and reports the path. It is the claim that drifts from it.
 */
export function unsavedArtifactClaims(text: string, saved: Set<string>): string[] {
  // save_artifact reports a full path; prose names a file. Compare basenames.
  const base = (p: string) => p.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  const actuallySaved = new Set([...saved].map(base));
  const bogus = new Set<string>();

  for (const raw of text.split(SENTENCES)) {
    const verb = raw.match(SAVE_VERB);
    if (!verb) continue;
    // Only what follows the verb — a file named before it is context, not a target.
    const tail = raw.slice(verb.index! + verb[0].length);
    SAVE_TARGET.lastIndex = 0;
    for (const m of tail.matchAll(SAVE_TARGET)) {
      if (!actuallySaved.has(base(m[1]))) bogus.add(m[1]);
    }
  }
  return [...bogus].slice(0, 5);
}

/**
 * Whether a provenance footer can be appended to this artifact without breaking it.
 *
 * Prose carries a footer fine. Source, config and data do not: a markdown line at the
 * end of a .cs file stops it compiling, and at the end of a .json file stops it
 * parsing. Generated tests are artifacts too, so this has to be a whitelist — anything
 * unrecognised is left alone.
 */
export function stampable(name: string): boolean {
  return /\.(?:md|markdown)$/i.test(name.trim());
}

/**
 * Refuse to write a deliverable that has no retrieved source behind it.
 *
 * Round 2's three worst cases were one move: ADR continued after the required BRD could
 * not be retrieved, Regression scored 5 by assessing candidate artifacts it never read,
 * and Traceability reconstructed requirements from derivative evidence when the approved
 * brief was unavailable. Each identified the gap and produced the artifact anyway.
 *
 * `list_artifacts` discovers what exists; `read_artifact` names something you expect.
 * Naming it and getting nothing back means a prerequisite is missing.
 *
 * Only fires when *nothing* was read successfully. An agent that guesses a name, misses,
 * then finds the right one through `list_artifacts` has done the right thing and must
 * not be punished for it. That leniency costs the case where one input of several is
 * missing; blocking correct recoveries would cost more.
 */
export function missingInputGate(
  toolName: string,
  failedReads: Set<string>,
  successfulReads: number
): string | null {
  if (toolName !== "save_artifact" || failedReads.size === 0 || successfulReads > 0) return null;

  const one = failedReads.size === 1;
  const list = [...failedReads].map((n) => `\`${n}\``).join(", ");
  return (
    `BLOCKED — the artifact was NOT saved.\n\n` +
    `This run asked for ${one ? "an input" : "inputs"} it could not retrieve: ${list}. ` +
    `Nothing else was read successfully either, so there is no retrieved source behind this deliverable.\n\n` +
    `Return a **BLOCKED** result naming what is missing and how to supply it. Do not reconstruct it from ` +
    `derivative evidence, do not infer its contents, and do not produce the deliverable without it — an ` +
    `artifact built on a source nobody can retrieve cannot be reviewed, approved, or trusted downstream.\n\n` +
    `If you guessed the name, call \`list_artifacts\` and read the real one; that clears this. ` +
    `If it genuinely does not exist yet, BLOCKED is the correct and complete answer — not a reason to invent it.`
  );
}
