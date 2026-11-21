/**
 * Pins the arithmetic in src/perf.ts: what is counted as model time, tool time and the reviewer's, and that the
 * usage of an API response is read whether or not it carries cache fields.
 *
 *   npm test
 */
import { RunPerf, formatPerf, usageOf } from "../src/perf.js";

let failures = 0;
const fail = (m: string) => { console.error(m); failures++; };
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

eq("usage fields are read, absent ones are zero", usageOf({ input_tokens: 5, output_tokens: 7 }), { input: 5, cacheRead: 0, cacheWrite: 0, output: 7 });
eq("a response with no usage is all zero", usageOf(undefined), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

const p = new RunPerf();
p.turn(30_000, { input: 10, cacheRead: 100_000, cacheWrite: 2_000, output: 4_000 });
p.turn(10_000, { input: 5, cacheRead: 110_000, cacheWrite: 0, output: 1_000 });
p.tool("write_section", 4_000);
p.tool("patch_section", 1_000);
p.tool("patch_section", 3_000);
p.reviewCall(60_000, { input: 1, cacheRead: 50_000, cacheWrite: 20_000, output: 3_000 });
p.reviewCall(40_000, { input: 1, cacheRead: 50_000, cacheWrite: 0, output: 2_000 });
p.reviewRound(70_000);

const s = p.summary();
eq("turns and model time add up", [s.turns, s.modelMs], [2, 40_000]);
eq("tokens add up across turns", s.usage, { input: 15, cacheRead: 210_000, cacheWrite: 2_000, output: 5_000 });
eq("tool time is the sum of the calls, the slowest tool first", s.tools, [{ name: "write_section", calls: 1, ms: 4_000 }, { name: "patch_section", calls: 2, ms: 4_000 }].sort((a, b) => b.ms - a.ms));
eq("tool time total", s.toolMs, 8_000);
eq("the reviewer's calls and its wall time are kept apart (calls run side by side)", [s.reviewer.calls, s.reviewer.callMs, s.reviewer.wallMs, s.reviewer.rounds], [2, 100_000, 70_000, 1]);
eq("the reviewer's tokens are its own, not the writer's", [s.reviewer.usage.output, s.usage.output], [5_000, 5_000]);

const line = formatPerf(s);
eq("the log line names the turns, the tools and the reviewer", [/2 turns/.test(line), /patch_section 2×/.test(line), /reviewer 1 round/.test(line), /^\[perf\]/.test(line)], [true, true, true, true]);
eq("no reviewer, no reviewer text", /reviewer/.test(formatPerf(new RunPerf().summary())), false);

console.log(`run performance — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
