/**
 * Refusing a save that would destroy a document.
 *
 * A live run saved 161 characters over a 148,929-character BRD — the model had been shown a
 * placeholder where its earlier saves were and wrote the placeholder as the document. Every
 * check then passed it, because a document with no citations has nothing to check. The earlier
 * version survived only because saves are versioned.
 *
 * Whatever the cause, a save that replaces a long document with a much shorter one is almost
 * never what was meant, and losing the work is much worse than asking once. The refusal is
 * lifted by sending the same content again, so a deliberate condensing is one repeat away.
 */

export type SaveKind = "document" | "section";

const FLOOR: Record<SaveKind, { minPrev: number; ratio: number }> = {
  document: { minPrev: 4000, ratio: 0.5 },
  section: { minPrev: 1500, ratio: 0.25 },
};

const CITATION = /GLD-[A-Z]+-\d+|inputs\/[^\s,;)\]*]+\.(?:md|txt)/gi;
/** Distinct numbered items a text defines: lines that open with an ID such as REQ-012, OQ-3 or BR-7. */
export const countIds = (text: string) =>
  new Set([...text.matchAll(/^\s*(?:#{1,6}\s+|[-*+]\s+|\|\s*|\d+\.\s+)?(?:\*\*|__)?\s*([A-Z]{1,6}-\d{1,4})\b/gm)].map((m) => m[1])).size;
/** How many checkable citations the text carries — what the server's other checks have to work with. */
export const countCitations = (text: string) => (text.match(CITATION) ?? []).length;

/**
 * A refusal message, or null when the save looks like an ordinary rewrite.
 *
 * Two signals, either of which refuses. The save is much shorter than what it replaces; or it
 * drops every citation from something that had several. The second is the one the size test
 * can miss and the content checks cannot see: with no citations there is nothing left to check,
 * so a rewrite that strips them all passes everything.
 */
export function destructiveSave(
  opts: { kind: SaveKind; newLen: number; prevLen: number | null; name: string; prevCitations?: number; newCitations?: number; prevIds?: number; newIds?: number }
): string | null {
  const { kind, newLen, prevLen, name } = opts;
  if (prevLen === null) return null;                       // nothing is being replaced
  const f = FLOOR[kind];
  const tiny = prevLen >= 1000 && newLen < 200;
  const pc = opts.prevCitations ?? 0, nc = opts.newCitations;
  // Every citation gone, or all but a few of a large number: the second keeps the checks alive on paper only.
  const lostCitations = (pc >= 5 && nc === 0) || (pc >= 10 && nc !== undefined && nc < pc * 0.2);
  const pi = opts.prevIds ?? 0, ni = opts.newIds;
  // Merging many short items into a few long ones keeps the length and loses the items.
  const lostIds = ni !== undefined && ((kind === "document" && pi >= 10 && ni < pi * 0.6) || (kind === "section" && pi >= 5 && ni < pi * 0.5));
  if (lostCitations && !tiny)
    return (
      `BLOCKED — nothing was saved. The ${kind} you sent (\`${name}\`) has ${nc === 0 ? "no citations" : "only " + nc + " citation" + (nc === 1 ? "" : "s")}, but the version it would replace has ${pc}. ` +
      `With no citations the server has nothing to check, so this would silence every check on the ${kind} rather than pass them.\n\n` +
      `Send the full ${kind} with its citations. If you really do mean to remove them all, send exactly the same content again and it will be saved ` +
      `(the previous version is always kept as \`${name}.vN\`).`
    );
  if (lostIds && !tiny)
    return (
      `BLOCKED — nothing was saved. The ${kind} you sent (\`${name}\`) defines ${ni} numbered item${ni === 1 ? "" : "s"}, but the version it would replace defines ${pi}. ` +
      `Merging items loses them: every requirement, question or rule that disappears is one nobody decided to drop.\n\n` +
      `Send the full ${kind} with its items. If you really do mean to merge them, send exactly the same content again and it will be saved ` +
      `(the previous version is always kept as \`${name}.vN\`).`
    );
  if (!tiny && !(prevLen >= f.minPrev && newLen < prevLen * f.ratio)) return null;
  return (
    `BLOCKED — nothing was saved. This would replace a ${prevLen.toLocaleString("en-US")}-character ${kind} (\`${name}\`) with ` +
    `${newLen.toLocaleString("en-US")} characters.\n\n` +
    `That is usually a mistake: a summary, a placeholder or a fragment sent instead of the full text. ` +
    `Send the complete ${kind}. If you really do mean to shrink it this much, send exactly the same content again and it will be saved ` +
    `(the previous version is always kept as \`${name}.vN\`).`
  );
}

/** A document this short cannot hold what a document-writing task asks for. */
export function implausiblyShort(chars: number, floor = 800): string | null {
  if (chars >= floor) return null;
  return (
    `⚠ **The saved document is only ${chars.toLocaleString("en-US")} characters** — too short to contain what the task asks for, ` +
    `so none of the other checks mean anything. If this replaced a longer version, that version is kept as the latest \`.vN\` copy of the file; ` +
    `restore it by writing the full document again.`
  );
}

/** A stable key for "this exact content", used to allow a repeat of a refused save. */
export function contentKey(name: string, content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  return `${name}|${content.length}|${h >>> 0}`;
}
