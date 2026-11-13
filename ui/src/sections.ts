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
      if (anchor >= 0) this.order.splice(anchor + 1, 0, key);
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
