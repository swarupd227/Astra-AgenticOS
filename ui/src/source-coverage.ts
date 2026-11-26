/**
 * A second reader for the client documents that have no headings.
 *
 * The item checks need headings: each leaf heading is an item, and a requirement either cites it or does not. A narrative
 * document (a business flow written as prose) has none, and comparing its sentences with the requirements by wording is
 * not workable: on a real 3,600-line flow it flagged 668 passages, because a BRD rightly does not restate every sentence of
 * a narrative. Telling a binding statement from background takes judgment, so a model reads the document in chunks against
 * a digest of the requirements and quotes each statement that obliges the business or the system and that no requirement
 * carries. The model call is injected; what is tested here is the chunking, the guard (a quote must be in the chunk it was
 * read from, or the finding is dropped), what is read again, and how the writer is told.
 */
import { createHash } from "node:crypto";

export type CoverageGap = { quote: string; why: string };
export type CoverageChunk = { source: string; text: string };
/** Asks the model about one chunk of one document, given the digest of the requirements. Null: no usable answer. */
export type AskCoverage = (chunk: CoverageChunk, digest: string, task: string) => Promise<CoverageGap[] | null>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sha = (s: string) => createHash("sha1").update(s).digest("hex");

export const COVERAGE_SYSTEM =
  `You are an independent reviewer of a Business Requirements Document (BRD). You did not write it. You are given a digest of its requirements (ID, name, statement) and then one part of a client document that has no section headings.\n\n` +
  `Find statements in that part of the document that bind the business or the system and that no requirement in the digest carries:\n` +
  `- Binding means the document says something must, should or may be done, held, recorded, validated, restricted or allowed, states a rule, a condition, a limit, a list of things to capture, or an order of steps that matters. A statement that only explains the business, describes how things are today, or narrates what a stage achieves is background: leave it.\n` +
  `- A requirement carries a statement when its wording says the same thing, even in other words or merged with related statements. Do not report a statement because the requirement is worded differently.\n` +
  `- The task the BRD was written for follows the digest. It sets the scope: a statement about something the task or the BRD puts out of scope (a lifecycle stage, an area, a feature the task says not to cover) is not a gap, whatever it obliges. Report only statements inside the scope.
` +
  `- Report only what you can show: quote the document's own sentence verbatim in quote (one sentence, or one list item with its lead-in), and say in why what it obliges and which requirement came closest, if any. A quote that is not in the part you were given is discarded.\n` +
  `- Report nothing for a part that has no uncovered binding statement. An empty list is a good answer.`;

export const COVERAGE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["gaps"],
  properties: {
    gaps: {
      type: "array", description: "Binding statements in this part of the document that no requirement carries.",
      items: { type: "object", additionalProperties: false, required: ["quote", "why"], properties: { quote: { type: "string", description: "The document's own sentence, verbatim." }, why: { type: "string" } } },
    },
  },
} as const;

/** The requirements as one short line each, for the reader to compare with: ID, name, and the start of the statement. */
export function requirementDigest(blocks: string[], maxStatement = 260): string {
  return blocks.map((b) => {
    const head = /^#{1,6}\s+(\S+)\s*[—–:-]\s*(.*)$/m.exec(b);
    const id = head?.[1] ?? /\b[A-Z]{1,6}-\d{1,4}\b/.exec(b)?.[0] ?? "";
    const st = /\*\*Requirement Statement:?\*\*:?\s*([\s\S]*?)(?:\n\s*\n|\n\*\*|$)/i.exec(b)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    return id ? `${id} — ${(head?.[2] ?? "").trim()}: ${st.length > maxStatement ? st.slice(0, maxStatement) + "…" : st}` : "";
  }).filter(Boolean).join("\n");
}

/** A document cut at blank lines into parts of about `size` characters, so a part never starts or ends inside a sentence. */
export function chunksOf(source: string, text: string, size = 12000): CoverageChunk[] {
  const out: CoverageChunk[] = [];
  let cur = "";
  for (const para of text.split(/\r?\n\s*\r?\n/)) {
    if (cur && cur.length + para.length > size) { out.push({ source, text: cur.trim() }); cur = ""; }
    cur += para + "\n\n";
  }
  if (cur.trim()) out.push({ source, text: cur.trim() });
  return out.filter((c) => c.text.length >= 200);
}

/** What has been read: a part that came back clean stays clean (requirements are added, not taken away); one with findings is read again when the requirements change. */
export class CoverageMemory {
  private clean = new Set<string>();
  private open = new Map<string, { digest: string; gaps: CoverageGap[] }>();
  key(c: CoverageChunk) { return sha(c.source + "\n" + c.text); }
  isClean(c: CoverageChunk) { return this.clean.has(this.key(c)); }
  /** The findings of this part from a read against the same requirements, if there was one. */
  sameDigest(c: CoverageChunk, digest: string) { const o = this.open.get(this.key(c)); return o && o.digest === sha(digest) ? o.gaps : null; }
  record(c: CoverageChunk, digest: string, gaps: CoverageGap[]) {
    if (!gaps.length) { this.clean.add(this.key(c)); this.open.delete(this.key(c)); } else this.open.set(this.key(c), { digest: sha(digest), gaps });
  }
}

export type CoverageReport = { chunks: number; read: number; findings: { source: string; quote: string; why: string }[]; droppedClaims: number; unreturned: number };

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]); }
  }));
  return out;
}

export async function reviewCoverage(opts: {
  documents: { source: string; text: string }[]; digest: string; task?: string; memory: CoverageMemory; ask: AskCoverage; concurrency?: number; chunkSize?: number;
}): Promise<CoverageReport> {
  const { digest, memory, ask } = opts;
  const chunks = opts.documents.flatMap((d) => chunksOf(d.source, d.text, opts.chunkSize));
  const findings: CoverageReport["findings"] = [];
  let read = 0, dropped = 0, unreturned = 0;
  await pool(chunks, opts.concurrency ?? 12, async (c) => {
    if (memory.isClean(c)) return;
    const same = memory.sameDigest(c, digest);
    let gaps = same;
    if (!gaps) {
      const got = await ask(c, digest, opts.task ?? "") ?? await ask(c, digest, opts.task ?? ""); // a bad answer is asked once more, then named, never read as clean
      if (!got) { unreturned++; return; }
      read++;
      const text = norm(c.text);
      gaps = got.filter((g) => {
        const q = g.quote?.split(/…|\.{3}/).map(norm).filter((p) => p.length >= 12) ?? [];
        const ok = q.length > 0 && q.every((p) => text.includes(p)) && !!g.why?.trim();
        if (!ok) dropped++;
        return ok;
      });
      memory.record(c, digest, gaps);
    }
    for (const g of gaps) findings.push({ source: c.source, quote: g.quote.replace(/\s+/g, " ").trim(), why: g.why.trim() });
  });
  return { chunks: chunks.length, read, findings, droppedClaims: dropped, unreturned };
}

export function formatCoverage(r: CoverageReport, max = 15): string | null {
  const lines: string[] = [];
  if (r.findings.length) {
    lines.push(
      `⚠ **Documents with no headings — a second reader found ${r.findings.length} binding statement${r.findings.length === 1 ? "" : "s"} no requirement carries** (read in ${r.chunks} part${r.chunks === 1 ? "" : "s"}):`,
      ...r.findings.slice(0, max).map((f) => `- ${f.source}: “${f.quote.length > 240 ? f.quote.slice(0, 240) + "…" : f.quote}”\n  ${f.why}`),
      ...(r.findings.length > max ? [`- …and ${r.findings.length - max} more.`] : []),
      `Where it is a need of the client, write a requirement for it (or add it to the requirement that covers its subject) and cite the document; where it is background, leave it.`,
    );
  }
  if (r.unreturned) lines.push(`⚠ **${r.unreturned} part${r.unreturned === 1 ? "" : "s"} of the documents with no headings could not be read by the second reader** — say so in your answer; they are not checked.`);
  return lines.length ? lines.join("\n") : null;
}
