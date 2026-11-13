/**
 * Runs the fixed evaluation cases against a live server and scores them.
 *
 *   npm run eval                                  # 2 runs of every case against localhost:5173
 *   npm run eval -- --base https://host --runs 3
 *   npm run eval -- --update-baseline             # record this result as the new baseline
 *
 * Each run builds its own throwaway documents-only project with NO Golden items visible,
 * so the result depends only on the fixture and the agent — never on whatever happens to
 * be in the organisation's library that day — and deletes it afterwards. It costs real
 * model calls; the fixtures are kept small for that reason.
 *
 * Exit code is non-zero when a hard property fails in any run, or a soft metric drifts
 * past tolerance from eval/baseline.json — so it can gate a change.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareToBaseline, hardChecks, scoreRun, worstOf,
  type Baseline, type EvalCase, type Metrics, type RunEvidence, type Verdict,
} from "./score.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const BASE = opt("base", "http://localhost:5173").replace(/\/$/, "");
const RUNS = Math.max(1, Number(opt("runs", "2")));
const ONLY = opt("case", "");
const UPDATE = argv.includes("--update-baseline");
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");

async function json(res: Response) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`); }
}

async function runOnce(c: EvalCase, dir: string): Promise<{ evidence: RunEvidence; metrics: Metrics }> {
  const task = fs.readFileSync(path.join(dir, "prompt.txt"), "utf8");
  const created = await json(await fetch(`${BASE}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    // Subset by a tag nothing carries: the agent sees no Golden items at all.
    body: JSON.stringify({ name: `eval-${c.id}-${Date.now()}`, type: "documents", golden: { mode: "subset", itemIds: [], tags: ["__eval_none__"] } }),
  }));
  if (!created.ok) throw new Error(`could not create project: ${created.error}`);
  const id: string = created.project.id;

  try {
    const inputTexts: Record<string, string> = {};
    for (const rel of c.inputs) {
      const buf = fs.readFileSync(path.join(dir, rel));
      inputTexts[rel] = buf.toString("utf8");
      const up = await json(await fetch(`${BASE}/api/projects/${id}/inputs?filename=${encodeURIComponent(path.basename(rel))}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: buf,
      }));
      if (!up.ok) throw new Error(`could not upload ${rel}: ${up.error}`);
    }

    const act = await fetch(`${BASE}/api/projects/${id}/activate`, { method: "POST" });
    const cookie = (act.headers.getSetCookie?.() ?? []).map((x) => x.split(";")[0]).join("; ");
    const activated = await json(act);
    if (!activated.ok) throw new Error(`could not activate project: ${activated.error}`);

    const started = Date.now();
    const chat = await fetch(`${BASE}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ agentId: c.agent, message: task }),
    });
    if (!chat.body) throw new Error("no response stream");
    const reads: RunEvidence["reads"] = [];
    let toolCalls = 0, buffer = "", failure = "";
    const decoder = new TextDecoder();
    for await (const chunk of chat.body as any) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let e: any; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "tool_call") {
          toolCalls++;
          if (e.name === "read_artifact") reads.push({ name: String(e.input?.name ?? ""), maxChars: e.input?.maxChars === undefined ? null : Number(e.input.maxChars) });
        }
        if (e.type === "error") failure = String(e.message);
      }
    }
    if (failure) throw new Error(`the run failed: ${failure}`);
    const seconds = Math.round((Date.now() - started) / 1000);

    const art = await json(await fetch(`${BASE}/api/artifacts/content?path=${encodeURIComponent(c.saveAs)}`, { headers: { cookie } }));
    if (!art.ok) throw new Error(`the agent did not save ${c.saveAs}: ${art.error}`);

    // Keep what the agent actually wrote: a score alone cannot be debugged.
    const keep = path.join(here, "results", RUN_STAMP);
    fs.mkdirSync(keep, { recursive: true });
    fs.writeFileSync(path.join(keep, `${c.id}-${Date.now()}.md`), String(art.content));

    const evidence: RunEvidence = { artifact: String(art.content), inputTexts, task, reads, toolCalls, seconds };
    return { evidence, metrics: scoreRun(c, evidence) };
  } finally {
    try { await fetch(`${BASE}/api/projects/${id}`, { method: "DELETE" }); } catch { /* best effort */ }
  }
}

function line(v: Verdict) { return `    ${v.ok ? "PASS" : "FAIL"}  ${v.metric.padEnd(32)} ${v.detail}`; }

async function main() {
  const fixtures = path.join(here, "fixtures");
  const dirs = fs.readdirSync(fixtures).filter((d) => fs.existsSync(path.join(fixtures, d, "case.json"))).filter((d) => !ONLY || d === ONLY);
  if (!dirs.length) throw new Error(`no evaluation case found${ONLY ? ` named ${ONLY}` : ""}`);

  const baselineFile = path.join(here, "baseline.json");
  const baselines: Record<string, Baseline> = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, "utf8")) : {};
  const results: Record<string, Metrics[]> = {};
  let failed = false;

  for (const d of dirs) {
    const dir = path.join(fixtures, d);
    const c: EvalCase = JSON.parse(fs.readFileSync(path.join(dir, "case.json"), "utf8"));
    console.log(`\n== ${c.id} — ${c.description}\n   ${RUNS} run(s) of agent "${c.agent}" against ${BASE}`);
    results[c.id] = [];
    for (let r = 1; r <= RUNS; r++) {
      try {
        const { metrics } = await runOnce(c, dir);
        results[c.id].push(metrics);
        const hard = hardChecks(c, metrics);
        if (hard.some((h) => !h.ok)) failed = true;
        console.log(`  run ${r}: ${metrics.characters} chars, ${metrics.toolCalls} tool calls, ${metrics.seconds}s, citations ${metrics.citationsChecked} checked / ${metrics.citationMissRate} miss rate`);
        hard.forEach((h) => console.log(line(h)));
      } catch (e) {
        failed = true;
        console.log(`  run ${r}: ERROR — ${(e as Error).message}`);
      }
    }
    const done = results[c.id];
    if (!done.length) continue;
    const worst = worstOf(done);
    const base = baselines[c.id];
    if (UPDATE) {
      baselines[c.id] = { case: c.id, recordedAt: new Date().toISOString(), runs: done.length, metrics: worst };
      console.log(`  baseline recorded for ${c.id} (worst of ${done.length} run(s))`);
    } else if (base) {
      console.log(`  against baseline recorded ${base.recordedAt.slice(0, 10)}:`);
      for (const v of compareToBaseline(worst, base.metrics)) { console.log(line(v)); if (!v.ok) failed = true; }
    } else {
      console.log("  no baseline yet — run with --update-baseline to record one");
    }
  }

  fs.mkdirSync(path.join(here, "results"), { recursive: true });
  fs.writeFileSync(path.join(here, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(results, null, 2));
  if (UPDATE) fs.writeFileSync(baselineFile, JSON.stringify(baselines, null, 2) + "\n");
  console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(2); });
