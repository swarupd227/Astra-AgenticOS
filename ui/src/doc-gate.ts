/**
 * The checks of a requirements document against the sources it was written from, in the order they are reported.
 * One list for every caller: the web app's agents (server.ts) and the quality gate other tools call (quality-mcp.ts),
 * so that what passes in one passes in the other. No file, model or project access: everything is passed in.
 */
import {
  citationKey, coverageGaps, danglingReferences, dependencyIssues, duplicateRequirements, flattenedSequences, formatCoverageGaps, formatDanglingReferences, formatDependencyIssues, formatDuplicateRequirements, formatFlattenedSequences, formatInventedRoles, formatItemLedger, formatOmittedDependencies, formatOmittedItemSentences, formatQuoteIssues, formatStrengthIssues, formatUncheckedItems, formatUngroundedFields, inventedRoles, itemLedger, omittedDependencies, omittedItemSentences, ownDocuments, quoteIssues, strengthIssues, ungroundedFields,
} from "./source-checks.js";
import { cutOffGapLists, formatCutOffLists, formatGapCitations, formatHiddenGaps, formatNarrowedLists, gapCitationIssues, hiddenGaps, narrowedLists } from "./source-gaps.js";

export type NamedSource = { name: string; text: string };

/** The client's own documents (not the task), keyed as a citation names them: `inputs/x.md` or `GLD-FS-002`. */
export function clientDocumentMap(all: NamedSource[]): Map<string, string> {
  return new Map(ownDocuments(all).filter((s) => s.name !== "task prompt").map((s) => [citationKey(s.name.split(" ")[0]), s.text]));
}

export function sourceChecks(input: {
  /** The document, with field tables already read as labelled lines (fieldRowsAsLabels). */
  doc: string;
  /** The sources the document cites that could be read, keyed by citationKey. */
  cited: Map<string, string>;
  /** Every source available to the writer, the task prompt first. */
  allSources: NamedSource[];
  /** false for one section of a document being built: some checks only make sense on the whole. */
  whole: boolean;
  /** Length of the document as saved. */
  length: number;
}): string[] {
  const { doc, cited, allSources, whole, length } = input;
  const notes: string[] = [];
  const strength = formatStrengthIssues(strengthIssues(doc, cited));
  if (strength) notes.push(strength);

  // What the requirements say about the gaps, decisions and lists in their sources.
  const gapRefs = formatGapCitations(gapCitationIssues(doc, cited));
  if (gapRefs) notes.push(gapRefs);
  const cutOff = formatCutOffLists(cutOffGapLists(doc, cited));
  if (cutOff) notes.push(cutOff);
  const hidden = formatHiddenGaps(hiddenGaps(doc, cited));
  if (hidden) notes.push(hidden);
  const narrowed = formatNarrowedLists(narrowedLists(doc, cited));
  if (narrowed) notes.push(narrowed);
  // Sentences of the source item a requirement cites that none of the requirements citing it carries.
  const longItems: string[] = [];
  const itemOmissions = formatOmittedItemSentences(omittedItemSentences(doc, cited, longItems));
  if (itemOmissions) notes.push(itemOmissions);
  // Steps the source draws as a sequence, written as a plain list or out of order.
  const sequences = formatFlattenedSequences(flattenedSequences(doc, cited));
  if (sequences) notes.push(sequences);
  // Only on the whole document: an area writer told "not checked" has nothing to fix and would spend a round on it.
  const uncheckedItems = whole ? formatUncheckedItems(longItems) : null;
  if (uncheckedItems) notes.push(uncheckedItems);

  const sourceTexts = allSources.map((s) => s.text);
  // What the document must carry comes from the task and this project's own documents; reference
  // items in the Golden Repository (code conventions, other products) are material to cite, not obligations.
  const ownTexts = ownDocuments(allSources).map((s) => s.text);
  const deps = formatDependencyIssues(dependencyIssues(doc, sourceTexts));
  if (deps) notes.push(deps);

  // Pointers into parts of the document that do not exist only make sense to judge on the whole document.
  if (whole) {
    const dangling = formatDanglingReferences(danglingReferences(doc, sourceTexts));
    if (dangling) notes.push(dangling);
    // Areas are written by separate writers; nothing else stops two of them stating the same requirement.
    const dupes = formatDuplicateRequirements(duplicateRequirements(doc));
    if (dupes) notes.push(dupes);
  }

  const roles = formatInventedRoles(inventedRoles(doc, sourceTexts));
  if (roles) notes.push(roles);

  const quotes = formatQuoteIssues(quoteIssues(doc, sourceTexts));
  if (quotes) notes.push(quotes);

  const fields = formatUngroundedFields(ungroundedFields(doc, sourceTexts));
  if (fields) notes.push(fields);

  // What is missing can only be judged on the whole document.
  if (whole) {
    const gaps = formatCoverageGaps(coverageGaps(doc, ownTexts), 12, length);
    if (gaps) notes.push(gaps);
    const omitted = formatOmittedDependencies(omittedDependencies(doc, ownTexts));
    if (omitted) notes.push(omitted);
    // Every item of the client's documents accounted for: covered, unresolved, excluded or not covered.
    const ledger = formatItemLedger(itemLedger(doc, clientDocumentMap(allSources)));
    if (ledger) notes.push(ledger);
  }
  return notes;
}
