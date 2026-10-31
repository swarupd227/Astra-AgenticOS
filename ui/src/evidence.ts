import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The evidence ledger: what tools observed, and which claims rest on it.
 *
 * Everything here is written by the server, never by an agent. An agent can cite an
 * evidence ID but cannot create one, so a citation is a lookup against something a
 * tool actually returned — the same shape as the Golden Repository citation check.
 *
 * Limits worth stating plainly: records are tamper-evident (output hash, file hashes),
 * not signed attestations — they do not prove who ran what. And every tool today is
 * static, so an observation here means "a tool returned this", never "this was run".
 */

export type EvidenceFile = { path: string; sha256: string };

export type EvidenceRecord = {
  id: string;
  at: string;
  runId: string;
  projectId: string;
  agent: string;
  tool: string;
  args: string;
  outputHash: string;
  excerpt: string;
  /** Files the observation was taken against, hashed at the time. Empty = unscoped. */
  files: EvidenceFile[];
  commit: string;
};

export type Risk = "low" | "medium" | "high";

export type Claim = {
  id: string;
  at: string;
  runId: string;
  projectId: string;
  agent: string;
  statement: string;
  /** What observation would show the statement false — written before relying on it. */
  disproof: string;
  risk: Risk;
  evidence: string[];
};

export type Freshness = "fresh" | "stale" | "unscoped";
export type ClaimStatus = "unsupported" | "stale" | "supported";

/** Tools whose results are worth recording as observations. */
export const EVIDENCE_TOOLS = new Set([
  "read_file", "search_code", "find_symbol", "find_references", "analyze_impact",
  "solution_overview", "semgrep_scan", "git_diff", "git_log", "git_show", "git_status",
  "propose_file_change",
]);

/** A refusal or failure is not an observation of anything. */
const NOT_AN_OBSERVATION = /^(?:ERROR|Refused:|Could not|No such|BLOCKED|Nothing to propose|Artifact not found)/;

export const isEvidenceTool = (name: string) => EVIDENCE_TOOLS.has(name);
export const isErrorResult = (text: string) => NOT_AN_OBSERVATION.test(text.trimStart());

export const sha256 = (data: string | Buffer) =>
  crypto.createHash("sha256").update(data).digest("hex");

const newId = (prefix: "EV" | "CL") => `${prefix}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

/** Args as a short human-readable line — never the content of a file being proposed. */
export function summarizeArgs(args: Record<string, unknown>): string {
  const bits = Object.entries(args).map(([k, v]) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    const flat = (s ?? "").replace(/\s+/g, " ");
    return `${k}=${flat.length > 80 ? flat.slice(0, 80) + "…" : flat}`;
  });
  return bits.join(" ").slice(0, 300);
}

/**
 * Which files a tool call observed, when that can be known. read_file accepts a
 * partial path or bare name, so the resolved path comes from its own result header
 * rather than from the argument.
 */
export function evidenceFilesFor(tool: string, args: Record<string, unknown>, result: string): string[] {
  if (tool === "read_file") {
    const m = result.match(/^# `([^`]+)`/);
    return m ? [m[1]] : [];
  }
  if (tool === "propose_file_change") {
    const p = String(args.targetPath ?? "").trim();
    return p ? [p] : [];
  }
  return [];
}

/** Join under root, or null if the relative path escapes it. */
export function safeJoin(root: string, rel: string): string | null {
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

const MAX_HASH_BYTES = 5 * 1024 * 1024;

/** sha256 of the file's bytes, "absent" if it does not exist, null if it cannot be hashed. */
export function hashFile(root: string, rel: string): string | null {
  const full = safeJoin(root, rel);
  if (!full) return null;
  try {
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > MAX_HASH_BYTES) return null;
    return sha256(fs.readFileSync(full));
  } catch (e: any) {
    return e?.code === "ENOENT" ? "absent" : null;
  }
}

/** Hash each path now, dropping any that cannot be hashed (they cannot be re-checked). */
export function snapshotFiles(root: string, rels: string[]): EvidenceFile[] {
  const out: EvidenceFile[] = [];
  for (const rel of new Set(rels)) {
    const h = hashFile(root, rel);
    if (h) out.push({ path: rel.replace(/\\/g, "/"), sha256: h });
  }
  return out;
}

/**
 * Is the evidence still about the code that is there now? Only as strong as its file
 * list: a record with no files cannot be checked and says so, rather than claiming
 * to be fresh.
 */
export function freshnessOf(rec: Pick<EvidenceRecord, "files">, root: string): Freshness {
  if (!rec.files.length) return "unscoped";
  for (const f of rec.files) if (hashFile(root, f.path) !== f.sha256) return "stale";
  return "fresh";
}

/** Unsupported = nothing cited; stale = any cited evidence has gone stale. */
export function claimStatus(claim: Pick<Claim, "evidence">, freshness: Map<string, Freshness>): ClaimStatus {
  if (!claim.evidence.length) return "unsupported";
  return claim.evidence.some((id) => freshness.get(id) === "stale") ? "stale" : "supported";
}

const CITATION = /\b(?:EV|CL)-[0-9A-F]{8}\b/g;

/** IDs the answer cites that do not exist for this project — invented or from elsewhere. */
export function unknownEvidenceCitations(text: string, known: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(CITATION)) if (!known.has(m[0])) found.add(m[0]);
  return [...found].slice(0, 10);
}

/** Keep the ledger bounded — a health signal and review aid, not an unbounded log. */
const MAX_EVIDENCE = 3000;
const MAX_CLAIMS = 1000;

type Line = { t: "e"; r: EvidenceRecord } | { t: "c"; r: Claim };

export class EvidenceStore {
  private readonly file: string;
  private evidence: EvidenceRecord[] = [];
  private claims: Claim[] = [];

  constructor(dir: string) {
    fs.mkdirSync(path.resolve(dir), { recursive: true });
    this.file = path.join(path.resolve(dir), "evidence.jsonl");
    this.load();
  }

  private load() {
    let over = false;
    try {
      for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const l = JSON.parse(line) as Line;
          if (l.t === "e") this.evidence.push(l.r);
          else if (l.t === "c") this.claims.push(l.r);
        } catch { /* a torn last line from a crash must not lose the rest */ }
      }
    } catch { return; }
    if (this.evidence.length > MAX_EVIDENCE) { this.evidence = this.evidence.slice(-MAX_EVIDENCE); over = true; }
    if (this.claims.length > MAX_CLAIMS) { this.claims = this.claims.slice(-MAX_CLAIMS); over = true; }
    if (over) this.compact();
  }

  private compact() {
    const lines = [
      ...this.evidence.map((r) => JSON.stringify({ t: "e", r })),
      ...this.claims.map((r) => JSON.stringify({ t: "c", r })),
    ];
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, lines.join("\n") + "\n");
    fs.renameSync(tmp, this.file);
  }

  private append(l: Line) {
    try { fs.appendFileSync(this.file, JSON.stringify(l) + "\n"); }
    catch (e) { console.error("[evidence] could not persist:", (e as Error).message); }
  }

  /** Never throws: failing to record must not lose the answer the user is waiting for. */
  addObservation(o: Omit<EvidenceRecord, "id" | "at">): EvidenceRecord {
    const rec: EvidenceRecord = { id: newId("EV"), at: new Date().toISOString(), ...o };
    this.evidence.push(rec);
    if (this.evidence.length > MAX_EVIDENCE) this.evidence = this.evidence.slice(-MAX_EVIDENCE);
    this.append({ t: "e", r: rec });
    return rec;
  }

  addClaim(c: Omit<Claim, "id" | "at">): Claim {
    const claim: Claim = { id: newId("CL"), at: new Date().toISOString(), ...c };
    this.claims.push(claim);
    if (this.claims.length > MAX_CLAIMS) this.claims = this.claims.slice(-MAX_CLAIMS);
    this.append({ t: "c", r: claim });
    return claim;
  }

  getEvidence(id: string, projectId: string): EvidenceRecord | undefined {
    return this.evidence.find((e) => e.id === id && e.projectId === projectId);
  }

  forProject(projectId: string) {
    return {
      evidence: this.evidence.filter((e) => e.projectId === projectId),
      claims: this.claims.filter((c) => c.projectId === projectId),
    };
  }

  /** Every ID a run may legitimately cite in this project. */
  knownIds(projectId: string): Set<string> {
    const { evidence, claims } = this.forProject(projectId);
    return new Set([...evidence.map((e) => e.id), ...claims.map((c) => c.id)]);
  }
}
