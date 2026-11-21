/**
 * Where a run's time and tokens go. Run 18 took 22.8 minutes and the only way to say where was to reconstruct a
 * timeline from keep-alive markers in the event stream (±15 s a step). This records it as it happens: each model
 * turn's duration and token usage, each tool's duration, and the independent reviewer's calls, so a change to a
 * run (parallel writers, a cheaper reviewer, fewer patch turns) can be measured rather than estimated.
 */
export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };
const zero = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const add = (a: Usage, b: Usage) => { a.input += b.input; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite; a.output += b.output; };

/** The token counts of an API response's `usage`, whichever of them are present. */
export function usageOf(u: any): Usage {
  return { input: u?.input_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0, output: u?.output_tokens ?? 0 };
}

export type PerfSummary = {
  wallMs: number;
  turns: number;
  /** Time spent waiting for the model to write a turn (including its tool calls' text). */
  modelMs: number;
  /** Time spent running tools, the independent reviewer's wait included. */
  toolMs: number;
  /** Summed over turns. `cacheRead` is the conversation re-read on every turn, which is why the number of turns costs money. */
  usage: Usage;
  tools: { name: string; calls: number; ms: number }[];
  reviewer: { rounds: number; calls: number; wallMs: number; callMs: number; usage: Usage };
  /** The requirement areas written in parallel (requirement-drafts.ts): their writer calls and the phase's wall time. */
  drafts: { areas: number; calls: number; wallMs: number; callMs: number; usage: Usage };
};

export class RunPerf {
  private started = Date.now();
  private turns = 0;
  private modelMs = 0;
  private usage = zero();
  private tools = new Map<string, { calls: number; ms: number }>();
  private rev = { rounds: 0, calls: 0, wallMs: 0, callMs: 0, usage: zero() };
  private dr = { areas: 0, calls: 0, wallMs: 0, callMs: 0, usage: zero() };

  turn(ms: number, u: Usage) { this.turns++; this.modelMs += ms; add(this.usage, u); }
  tool(name: string, ms: number) {
    const t = this.tools.get(name) ?? { calls: 0, ms: 0 };
    t.calls++; t.ms += ms; this.tools.set(name, t);
  }
  /** One call to the reviewing model (several run side by side in a round). */
  reviewCall(ms: number, u: Usage) { this.rev.calls++; this.rev.callMs += ms; add(this.rev.usage, u); }
  /** One reading of the document by the reviewer, start to finish. */
  reviewRound(wallMs: number) { this.rev.rounds++; this.rev.wallMs += wallMs; }
  /** One call by an area's writer (draft or fix). */
  draftCall(ms: number, u: Usage) { this.dr.calls++; this.dr.callMs += ms; add(this.dr.usage, u); }
  /** The whole parallel drafting phase, start to finish. */
  draftPhase(areas: number, wallMs: number) { this.dr.areas += areas; this.dr.wallMs += wallMs; }

  summary(now = Date.now()): PerfSummary {
    const toolMs = [...this.tools.values()].reduce((s, t) => s + t.ms, 0);
    return {
      wallMs: now - this.started, turns: this.turns, modelMs: this.modelMs, toolMs, usage: { ...this.usage },
      tools: [...this.tools.entries()].map(([name, t]) => ({ name, ...t })).sort((a, b) => b.ms - a.ms),
      reviewer: { ...this.rev, usage: { ...this.rev.usage } },
      drafts: { ...this.dr, usage: { ...this.dr.usage } },
    };
  }
}

const min = (ms: number) => (ms / 60000).toFixed(1);
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}K`);

/** One log line a person can read, with the tools that took the time. */
export function formatPerf(s: PerfSummary): string {
  const top = s.tools.slice(0, 5).map((t) => `${t.name} ${t.calls}×${min(t.ms)}m`).join(", ");
  const r = s.reviewer;
  return (
    `[perf] ${min(s.wallMs)} min: model ${min(s.modelMs)} min over ${s.turns} turns, tools ${min(s.toolMs)} min (${top}); ` +
    `tokens out ${k(s.usage.output)}, cache read ${k(s.usage.cacheRead)}, cache write ${k(s.usage.cacheWrite)}, uncached in ${k(s.usage.input)}` +
    (r.calls ? `; reviewer ${r.rounds} round(s) ${min(r.wallMs)} min, ${r.calls} calls, out ${k(r.usage.output)}, cache read ${k(r.usage.cacheRead)}` : "") +
    (s.drafts.calls ? `; drafts ${s.drafts.areas} areas ${min(s.drafts.wallMs)} min, ${s.drafts.calls} calls, out ${k(s.drafts.usage.output)}, cache read ${k(s.drafts.usage.cacheRead)}` : "")
  );
}
