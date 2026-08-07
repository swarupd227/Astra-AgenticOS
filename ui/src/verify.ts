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

/** A heading names a section; whatever it introduces is checked on its own terms. */
const HEADING = /^#{1,6}\s/;

/**
 * A table row whose value is nothing to act on — "| Unused / safe to remove | 0 |".
 * The phrase is a row label and the answer is zero, which is the opposite of a verdict.
 */
const NOTHING_TO_ACT_ON = /^\|.*\|\s*\**\s*(?:0|none|nil|n\/?a|—|-)\s*\**\s*\|?\s*$/i;

/**
 * Compatibility verdicts that never say which compatibility they mean.
 *
 * Naming a kind is enough to pass — this forces the question to be answered, it does
 * not judge the answer. A hedged verdict passes too: "should be source-compatible" is
 * already an admission that it was not verified.
 *
 * Headings and empty-result table rows are skipped. A dead-code review that correctly
 * found nothing removable was flagged twice — once for the section heading "Safe to
 * Remove" over an empty list, and once for the row "| Unused / safe to remove | 0 |".
 * Both are labels rather than claims, and crying wolf on a clean answer is how a check
 * teaches people to ignore it. Verdicts inside table cells are still caught; it is only
 * the rows reporting nothing that are let through.
 */
export function unqualifiedCompatibility(text: string): string[] {
  const found: string[] = [];
  for (const raw of text.split(SENTENCES)) {
    const s = raw.trim();
    if (!s || s.length > 400) continue;
    if (HEADING.test(s) || NOTHING_TO_ACT_ON.test(s)) continue;
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
 * A failure is cleared only by later reading *that same name* — never by reading
 * something else. The first version stood down as soon as any read succeeded, on the
 * theory that an agent which guessed a name and then found the right one had recovered.
 * Tested against the live deployment, Traceability failed to read the approved brief,
 * successfully read two unrelated artifacts while exploring, and wrote its matrix
 * anyway: "the BRD is absent from the repository entirely. However, I have a rich
 * enough codebase to derive the functional requirements from the code." Reading
 * something else is not a recovery, and the leniency reproduced the exact defect.
 *
 * The cost is the genuine misspelling, which now blocks. That is the cheaper error:
 * the message says how to clear it, and `read_artifact` is documented as "use after
 * list_artifacts" precisely so names do not have to be guessed.
 */
export function missingInputGate(toolName: string, failedReads: Set<string>): string | null {
  if (toolName !== "save_artifact" || failedReads.size === 0) return null;
  return blockedMessage([...failedReads]);
}

/** A file the request names, e.g. `brd-basket-approved.md` or `Basket.cs`. */
const FILENAME = /`?\b([\w.-]+\.[A-Za-z0-9]{1,5})\b`?/g;

/** Words that mark the *next* filename as the thing to write, not a thing to read. */
const OUTPUT_POSITION = /\b(?:save|saved|saving|write|written|store|persist|output|as|named|call it|produce)\b[^.]{0,30}$/i;

/**
 * Files the request names as inputs — what it expects you to have read.
 *
 * The failed-read gate turned out to catch only the clumsy path. Tested against the
 * live deployment, Traceability called `list_artifacts`, saw the approved brief was
 * absent, never attempted to read it, and wrote the matrix from whatever else was
 * lying around. No read failed, so nothing fired. The agent that behaves well enough
 * to list before reading was the one that slipped through.
 *
 * What the request names is the firmer signal: "trace from brd-basket-approved.md"
 * declares a prerequisite whether or not the agent ever tries to open it. The filename
 * it is told to save under is excluded — that is the output, not an input.
 */
export function requiredInputs(message: string): string[] {
  const found = new Set<string>();
  for (const m of message.matchAll(FILENAME)) {
    const before = message.slice(Math.max(0, m.index! - 40), m.index!);
    if (OUTPUT_POSITION.test(before)) continue;
    found.add(m[1]);
  }
  return [...found];
}

/**
 * Inputs the request named that this run never actually opened.
 *
 * Compares basenames: the request says `Basket.cs`, the tool was given
 * `src/Basket.API/Basket.cs`, and those are the same file.
 */
export function unreadRequiredInputs(required: string[], readOk: Set<string>): string[] {
  const base = (p: string) => p.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  const opened = new Set([...readOk].map(base));
  return required.filter((r) => !opened.has(base(r)));
}

/** The refusal, shared by both routes into the gate. */
function blockedMessage(missing: string[]): string {
  const one = missing.length === 1;
  const list = missing.map((n) => `\`${n}\``).join(", ");
  return (
    `BLOCKED — the artifact was NOT saved.\n\n` +
    `This task names ${one ? "an input" : "inputs"} that this run never opened: ${list}. ` +
    `There is no retrieved source behind the deliverable you are trying to write.\n\n` +
    `Return a **BLOCKED** result naming what is missing and how to supply it. Do not reconstruct it from ` +
    `derivative evidence, do not infer its contents, and do not produce the deliverable without it — an ` +
    `artifact built on a source nobody can retrieve cannot be reviewed, approved, or trusted downstream.\n\n` +
    `Reading ${one ? "that file" : "those files"} is what clears this. Reading something else does not: ` +
    `deriving the requirements from whatever happens to be available is the exact failure this prevents. ` +
    `If the name is wrong, \`list_artifacts\` will show the real one.\n\n` +
    `If it genuinely does not exist yet, BLOCKED is the correct and complete answer — not a reason to invent it.`
  );
}

/**
 * The gate as the run actually uses it: block a save when the task named inputs this
 * run never opened, whether the agent tried and failed or never tried at all.
 */
export function prerequisiteGate(
  toolName: string,
  required: string[],
  readOk: Set<string>,
  failedReads: Set<string>
): string | null {
  if (toolName !== "save_artifact") return null;
  const missing = [...new Set([...unreadRequiredInputs(required, readOk), ...failedReads])];
  return missing.length ? blockedMessage(missing) : null;
}
