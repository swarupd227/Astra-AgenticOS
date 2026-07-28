import fs from "node:fs";
import path from "node:path";

/**
 * What the Golden Repository is actually doing for us.
 *
 * Every run already knows which items it opened and which it cited — the
 * citation check compares exactly those two sets — and then throws the answer
 * away. So nobody can tell a standard the agents lean on from one nobody has
 * opened since it was written. Both look identical in the library.
 *
 * This records one small row per run so that question has an answer. It is
 * deliberately not analytics: no user identity, no prompts, no output text —
 * only which documents were consulted, by which agent, and when.
 */
export type GoldenUsageRun = {
  at: string;
  /** Agent id, e.g. "code-reviewer". */
  agent: string;
  /** Project id the run was scoped to. */
  project: string;
  /** Items actually opened with golden_read. */
  read: string[];
  /** Items cited as `id@version` in the answer. */
  cited: string[];
  /** Cited but never opened — a claim written from the catalog summary. */
  unverified: string[];
};

export type GoldenItemHealth = {
  id: string;
  reads: number;
  citations: number;
  unverified: number;
  lastUsed: string | null;
  /** Agent ids that have opened this item, most recent first. */
  agents: string[];
};

/** Keep the file bounded — this is a health signal, not an audit log. */
const MAX_RUNS = 1000;

export class GoldenUsageStore {
  private readonly file: string;
  private runs: GoldenUsageRun[] = [];
  /** Serialises writes, matching GoldenStore — runs can overlap. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.file = path.join(path.resolve(dir), "usage.json");
    this.load();
  }

  private load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.runs = Array.isArray(raw.runs) ? raw.runs : [];
    } catch { this.runs = []; }
  }

  private write() {
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ runs: this.runs }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /**
   * Record one finished run. Never throws: a failure to write a usage row must
   * not lose the answer the user is waiting for.
   */
  record(run: GoldenUsageRun): Promise<void> {
    const next = this.queue.then(() => {
      try {
        this.load();                       // don't clobber a concurrent run's row
        this.runs.push(run);
        if (this.runs.length > MAX_RUNS) this.runs = this.runs.slice(-MAX_RUNS);
        this.write();
      } catch (e) {
        console.error("[golden] could not record usage:", (e as Error).message);
      }
    });
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Per-item totals, keyed by item id. */
  health(): { runs: number; since: string | null; byItem: Map<string, GoldenItemHealth> } {
    this.load();
    const byItem = new Map<string, GoldenItemHealth>();

    const touch = (id: string) => {
      let h = byItem.get(id);
      if (!h) { h = { id, reads: 0, citations: 0, unverified: 0, lastUsed: null, agents: [] }; byItem.set(id, h); }
      return h;
    };

    for (const r of this.runs) {
      for (const id of r.read) {
        const h = touch(id);
        h.reads++;
        // `at` is monotonic in practice (runs are appended), so last write wins.
        h.lastUsed = r.at;
        if (!h.agents.includes(r.agent)) h.agents.push(r.agent);
      }
      for (const id of r.cited) touch(id).citations++;
      for (const id of r.unverified) touch(id).unverified++;
    }

    return {
      runs: this.runs.length,
      since: this.runs.length ? this.runs[0].at : null,
      byItem,
    };
  }
}
