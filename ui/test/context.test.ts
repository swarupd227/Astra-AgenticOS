/**
 * Pins the conversation compaction in src/context.ts.
 *
 *   npm test
 */
import { supersedeOldSaves } from "../src/context.js";

let failures = 0;
const fail = (m: string) => { console.error(m); failures++; };
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

const save = (name: string, content: string, id: string) => ({ type: "tool_use", id, name: "save_artifact", input: { name, content } });
const doc = (n: number) => "x".repeat(n);

{
  const messages: any[] = [
    { role: "user", content: "write it" },
    { role: "assistant", content: [{ type: "text", text: "saving" }, save("brd.md", doc(1000), "a")] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "Saved artifact to brd.md" }] },
    { role: "assistant", content: [save("brd.md", doc(2000), "b")] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "Updated existing artifact" }] },
    { role: "assistant", content: [save("brd.md", doc(3000), "c")] },
  ];
  const freed = supersedeOldSaves(messages);
  eq("the characters of both older copies are reported as freed", freed, 3000);
  eq("the latest save is untouched", messages[5].content[0].input.content.length, 3000);
  if (!String(messages[1].content[1].input.content).includes("1,000 characters")) fail("the oldest copy should become a note saying how long it was");
  if (messages[1].content[1].input.content.length > 200) fail("the replaced copy should be short");
  eq("the middle copy is replaced too", String(messages[3].content[0].input.content).startsWith("[an earlier version"), true);
  eq("the file name is kept on every save", messages[1].content[1].input.name, "brd.md");
  eq("tool results are never touched", messages[2].content[0].content, "Saved artifact to brd.md");
  eq("other blocks in the same message are never touched", messages[1].content[0].text, "saving");
  eq("a second pass changes nothing", supersedeOldSaves(messages), 0);
}

{
  // Different files are different documents: each keeps its latest copy.
  const messages: any[] = [
    { role: "assistant", content: [save("a.md", doc(500), "1"), save("b.md", doc(600), "2")] },
    { role: "assistant", content: [save("a.md", doc(700), "3")] },
  ];
  const freed = supersedeOldSaves(messages);
  eq("only the superseded copy of a.md is dropped", freed, 500);
  eq("b.md has only one copy, so it stays whole", messages[0].content[1].input.content.length, 600);
  eq("a.md's latest copy stays whole", messages[1].content[0].input.content.length, 700);
}

eq("a single save is never compacted", supersedeOldSaves([{ role: "assistant", content: [save("a.md", doc(900), "1")] }] as any), 0);
eq("other tools are never compacted",
  supersedeOldSaves([
    { role: "assistant", content: [{ type: "tool_use", id: "1", name: "read_file", input: { path: "x", content: doc(900) } }] },
    { role: "assistant", content: [{ type: "tool_use", id: "2", name: "read_file", input: { path: "x", content: doc(900) } }] },
  ] as any), 0);
eq("an empty conversation is fine", supersedeOldSaves([]), 0);
eq("string-content messages are skipped", supersedeOldSaves([{ role: "user", content: "hello" }] as any), 0);

console.log(`conversation compaction — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
