/**
 * A document built one section at a time.
 *
 * Writing a 100,000-character document in one `save_artifact` call takes minutes with nothing
 * to show for it, and every correction meant writing all of it again: a live run generated six
 * full copies. Here the agent writes a section, the server keeps the order and composes the
 * whole, and a fix is rewriting the one section that was wrong. Total generation falls from
 * about six copies to about one, and each section can be checked the moment it exists.
 *
 * Pure, so the ordering rules can be tested without a server.
 */

/** Sections are matched by title, ignoring case and punctuation but keeping numbering. */
export const sectionKey = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The leading number of a section title ("6.2 Billing" → [6, 2]), or null. */
export function sectionNumber(title: string): number[] | null {
  const m = /^\s*(?:section\s+|chapter\s+)?(\d+(?:\.\d+)*)\.?(?:\s|$)/i.exec(title);
  return m ? m[1].split(".").map(Number) : null;
}
function compareNumbers(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1, y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

export class SectionedDoc {
  private order: string[] = [];
  private parts = new Map<string, { title: string; text: string }>();

  has(title: string): boolean { return this.parts.has(sectionKey(title)); }

  titles(): string[] { return this.order.map((k) => this.parts.get(k)!.title); }

  /**
   * Add a section, or replace one of the same title in place. A new section goes at the end
   * unless `after` names an existing section. Content that does not open with a heading gets
   * one from the title, so a composed document always has the structure it appears to have.
   * Returns whether an existing section was replaced.
   */
  set(title: string, content: string, after?: string): boolean {
    const key = sectionKey(title);
    const text = (/^\s*#{1,6}\s/.test(content) ? content : `## ${title.trim()}\n\n${content}`).replace(/\s+$/, "");
    const existed = this.parts.has(key);
    this.parts.set(key, { title: title.trim(), text });
    if (!existed) {
      const anchor = after ? this.order.indexOf(sectionKey(after)) : -1;
      // A numbered section with no anchor goes before the first section numbered after it, so chapters can be
      // written in any order (the requirements chapter is started first and drafted while "5.1" is written).
      const num = sectionNumber(title);
      const later = anchor < 0 && num ? this.order.findIndex((k) => { const n = sectionNumber(this.parts.get(k)!.title); return !!n && compareNumbers(n, num) > 0; }) : -1;
      if (anchor >= 0) this.order.splice(anchor + 1, 0, key);
      else if (later >= 0) this.order.splice(later, 0, key);
      else this.order.push(key);
    }
    return existed;
  }

  compose(): string {
    return this.order.map((k) => this.parts.get(k)!.text).join("\n\n") + "\n";
  }

  /** The text of one section as written, or null. */
  text(title: string): string | null { return this.parts.get(sectionKey(title))?.text ?? null; }
}

export type Edit = { find: string; replace: string };
export type PatchResult = { ok: true; text: string; changes: number } | { ok: false; error: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every place `find` occurs: exactly, or failing that with any run of whitespace standing for any other. */
function occurrences(text: string, find: string): { index: number; length: number }[] {
  const hits: { index: number; length: number }[] = [];
  for (let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + find.length)) hits.push({ index: i, length: find.length });
  if (hits.length) return hits;
  const tokens = find.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return hits;
  for (const m of text.matchAll(new RegExp(tokens.map(escapeRe).join("\\s+"), "g"))) hits.push({ index: m.index!, length: m[0].length });
  return hits;
}

/**
 * Change part of a section without sending the rest of it. Fixing one finding by rewriting a whole
 * section cost a live run 50 rewrites of 71 saves, most of them re-sending 5–15K characters to change
 * a sentence. Each `find` must match exactly one place (ignoring differences in whitespace), so an
 * edit can never land on the wrong requirement; all edits apply or none do, so a half-applied fix
 * cannot leave a section broken. Edits apply in order, each to the result of the one before.
 */
export function applyEdits(text: string, edits: Edit[]): PatchResult {
  if (!edits.length) return { ok: false, error: "No edits were given." };
  let out = text;
  for (const [i, e] of edits.entries()) {
    const n = `Edit ${i + 1}`;
    if (typeof e?.find !== "string" || !e.find.trim()) return { ok: false, error: `${n}: \`find\` is empty. Give the exact text to change.` };
    if (typeof e.replace !== "string") return { ok: false, error: `${n}: \`replace\` is missing (use an empty string to delete the text).` };
    const hits = occurrences(out, e.find);
    if (hits.length === 0) return { ok: false, error: `${n}: the text to change was not found in the section: “${e.find.replace(/\s+/g, " ").slice(0, 100)}”. Copy it exactly from the section as you wrote it.` };
    if (hits.length > 1) return { ok: false, error: `${n}: the text to change appears ${hits.length} times in the section: “${e.find.replace(/\s+/g, " ").slice(0, 100)}”. Include more of the surrounding words so it matches one place.` };
    out = out.slice(0, hits[0].index) + e.replace + out.slice(hits[0].index + hits[0].length);
  }
  return { ok: true, text: out, changes: edits.length };
}
