/**
 * Keeping a long run's conversation from growing faster than it needs to.
 *
 * `save_artifact` carries the whole document. An agent that is shown problems with what it
 * saved fixes them by saving again — correctly — but every earlier copy stays in the
 * conversation, so a 140,000-character document saved five times puts five copies in front
 * of the model on every following turn — in the client BRD runs, about 35,000 tokens each, so
 * five saves meant roughly 175,000 tokens of repeats billed and carried on every later
 * request, against a context limit.
 *
 * Only the latest save of a given name matters: it is what the agent edits from, and the
 * earlier ones were already answered by their tool results. Older copies are replaced with
 * a one-line note. Nothing is lost — each superseded version is kept on disk as `<name>.vN`.
 */
const NOTE = "[an earlier version of this document was omitted from the conversation to save space";

type Block = { type?: string; name?: string; input?: { name?: unknown; content?: unknown } & Record<string, unknown> };
type Message = { role?: string; content?: unknown };

/** Replace superseded `save_artifact` bodies in place. Returns how many characters were dropped. */
export function supersedeOldSaves(messages: Message[]): number {
  const saves: { block: Block; name: string; chars: number }[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as Block[]) {
      if (b?.type === "tool_use" && b.name === "save_artifact" && typeof b.input?.content === "string")
        saves.push({ block: b, name: String(b.input.name ?? ""), chars: b.input.content.length });
    }
  }
  const last = new Map<string, number>();
  saves.forEach((s, i) => last.set(s.name, i));

  let freed = 0;
  saves.forEach((s, i) => {
    if (last.get(s.name) === i) return;                       // the latest of its name stays whole
    const content = String(s.block.input!.content);
    if (content.startsWith(NOTE)) return;                     // already replaced on an earlier turn
    s.block.input = { ...s.block.input, content: `${NOTE}: ${s.chars.toLocaleString("en-US")} characters, superseded by a later save of ${s.name || "the same file"}]` };
    freed += s.chars;
  });
  return freed;
}
