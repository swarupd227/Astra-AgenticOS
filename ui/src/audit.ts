/**
 * Static before/after audit of a proposed file change.
 *
 * Each check runs on the file as it is now and on the file as proposed, and reports
 * what the change introduces and what it resolves — a delta, not a verdict about the
 * whole file. Matching lines are compared as a multiset, so a line that merely moved
 * is neither introduced nor resolved, and no diff library is needed.
 *
 * What this is not: it runs nothing and executes nothing. Every check is a pattern
 * over text, so each one is a heuristic with known blind spots, and the dimensions
 * that need a build, a test run or a scanner are listed as not assessed rather than
 * quietly omitted. Pure functions throughout, so the lines they draw can be tested.
 */

export type Finding = { line: number; text: string };

export type DimensionStatus = "ok" | "attention" | "info";

export type DimensionResult = {
  name: string;
  before: number;
  after: number;
  /** Present after the change, absent before it. */
  introduced: Finding[];
  /** Present before the change, gone after it. */
  resolved: number;
  status: DimensionStatus;
  note?: string;
};

export type Audit = {
  path: string;
  kind: "create" | "modify";
  dimensions: DimensionResult[];
  notAssessed: { name: string; reason: string }[];
};

type Matcher = { re: RegExp; label?: (m: RegExpExecArray) => string | null };

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** 1-based line number of a character offset. */
function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Every match of every matcher, with its line. A matcher may veto a match via `label`. */
function scan(text: string, matchers: Matcher[]): Finding[] {
  const out: Finding[] = [];
  for (const { re, label } of matchers) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (let m = g.exec(text); m; m = g.exec(text)) {
      if (m[0].length === 0) { g.lastIndex++; continue; }
      const t = label ? label(m) : m[0];
      if (t === null) continue;
      out.push({ line: lineAt(text, m.index), text: norm(t).slice(0, 100) });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * Multiset difference of findings by normalized text. A finding present before and
 * after is carried over, wherever it sits; only the surplus counts as new or gone.
 */
function delta(before: Finding[], after: Finding[]): { introduced: Finding[]; resolved: number } {
  const left = new Map<string, number>();
  for (const f of before) left.set(f.text, (left.get(f.text) ?? 0) + 1);
  const introduced: Finding[] = [];
  for (const f of after) {
    const n = left.get(f.text) ?? 0;
    if (n > 0) left.set(f.text, n - 1);
    else introduced.push(f);
  }
  let resolved = 0;
  for (const n of left.values()) resolved += n;
  return { introduced, resolved };
}

function dimension(
  name: string, before: Finding[], after: Finding[], attentionIfIntroduced = true, note?: string
): DimensionResult {
  const { introduced, resolved } = delta(before, after);
  return {
    name, before: before.length, after: after.length, introduced, resolved,
    status: attentionIfIntroduced && introduced.length ? "attention" : "ok",
    ...(note ? { note } : {}),
  };
}

// --- Secrets ------------------------------------------------------------------------

const PLACEHOLDER = /^(?:x{3,}|\*{3,}|changeme|change_me|your[_-]|example|placeholder|dummy|sample|test|<.*>|\$\{.*\}|%\(.*\)s|\{\{.*\}\})/i;

const SECRET_MATCHERS: Matcher[] = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, label: () => "private key block" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: () => "AWS access key id" },
  {
    // A secret-ish name assigned a quoted literal. The value is never kept: a finding
    // that echoed it would put the secret into the audit file and the chat.
    re: /(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|token)["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i,
    label: (m) => (PLACEHOLDER.test(m[1]) ? null : "credential-like literal"),
  },
];

// --- Error handling -----------------------------------------------------------------

// Whitespace and comments only. A body holding just "// TODO" or "/* ignore */" still
// swallows the error — that is what an "intentionally ignored" handler looks like — so
// a comment does not make it a handled one. Found when a live run added exactly that.
const BLANK = String.raw`(?:\s|//[^\n]*|/\*[\s\S]*?\*/)*`;

const SWALLOWED: Matcher[] = [
  { re: new RegExp(String.raw`\bcatch\b\s*(?:\([^)]*\))?\s*\{${BLANK}\}`), label: () => "empty catch block" },
  { re: new RegExp(String.raw`\.catch\(\s*(?:\([^)]*\)|\w*)\s*=>\s*\{${BLANK}\}\s*\)`), label: () => "promise rejection swallowed" },
  { re: /\bexcept\b[^:\n]*:\s*(?:#[^\n]*\n\s*)*pass\b/, label: () => "except: pass" },
  { re: /\brescue\b[^\n]*\n(?:\s*#[^\n]*\n)*\s*end\b/, label: () => "empty rescue" },
  { re: new RegExp(String.raw`\bif\s+err\s*!=\s*nil\s*\{${BLANK}\}`), label: () => "error checked and ignored" },
];

// --- TODO debt ----------------------------------------------------------------------

function todoFindings(text: string): Finding[] {
  const out: Finding[] = [];
  text.split("\n").forEach((l, i) => {
    if (/\b(?:TODO|FIXME|HACK|XXX)\b/.test(l)) out.push({ line: i + 1, text: norm(l).slice(0, 100) });
  });
  return out;
}

// --- Comment density ----------------------------------------------------------------

const SLASH = ["cs", "java", "ts", "tsx", "js", "jsx", "go", "rs", "scala", "c", "cc", "cpp", "h", "hpp", "php", "kt", "swift"];
const HASH = ["py", "rb", "sh", "bash", "yml", "yaml"];

function commentPrefix(path: string): string[] | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (SLASH.includes(ext)) return ["//"];
  if (HASH.includes(ext)) return ["#"];
  return null;
}

function commentStats(text: string, prefixes: string[]) {
  let comments = 0, nonBlank = 0;
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    nonBlank++;
    if (prefixes.some((p) => l.startsWith(p))) comments++;
  }
  return { comments, nonBlank };
}

// --- Tests --------------------------------------------------------------------------

const SOURCE_EXT = new RegExp(`\\.(?:${[...SLASH, "py", "rb"].join("|")})$`, "i");

export function isTestPath(p: string): boolean {
  const f = p.replace(/\\/g, "/");
  return (
    /(?:^|\/)(?:tests?|__tests__|spec|specs)\//i.test(f) ||
    /\.(?:test|spec)\.[a-z]+$/i.test(f) ||
    /_test\.(?:go|py|rb|rs|php)$/i.test(f) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(f) ||
    /Tests?\.(?:cs|java|kt|scala|php)$/.test(f)
  );
}

/**
 * Source files proposed this run when no test file was proposed alongside them.
 * Says nothing about whether tests already exist elsewhere — only that this change
 * set has none, which is what a reviewer needs to know.
 */
export function proposalsWithoutTests(paths: string[]): string[] {
  const sources = paths.filter((p) => SOURCE_EXT.test(p) && !isTestPath(p));
  return sources.length && !paths.some(isTestPath) ? sources : [];
}

// --- The audit ----------------------------------------------------------------------

const NOT_ASSESSED: Audit["notAssessed"] = [
  { name: "Build", reason: "nothing is compiled or run here" },
  { name: "Scanner-based security", reason: "no scanner was run on the proposed content" },
  { name: "Telemetry", reason: "needs data-flow analysis" },
  { name: "Accessibility", reason: "needs a rendered UI" },
  { name: "Performance", reason: "needs a benchmark or profile" },
  { name: "Documentation drift", reason: "needs the spec to compare against" },
];

export function auditChange(path: string, kind: "create" | "modify", before: string, after: string): Audit {
  const dims: DimensionResult[] = [
    dimension("Secrets", scan(before, SECRET_MATCHERS), scan(after, SECRET_MATCHERS), true,
      "Pattern match for credential-like literals; values are never recorded."),
    dimension("Error handling", scan(before, SWALLOWED), scan(after, SWALLOWED), true,
      "Empty or swallowing handlers only; it cannot see logic that merely handles errors badly."),
    dimension("TODO debt", todoFindings(before), todoFindings(after), true),
  ];

  const prefixes = commentPrefix(path);
  if (prefixes) {
    const b = commentStats(before, prefixes), a = commentStats(after, prefixes);
    const ratio = a.nonBlank ? a.comments / a.nonBlank : 0;
    const flagged = ratio > 0.4 && a.comments - b.comments >= 5;
    dims.push({
      name: "Comment density", before: b.comments, after: a.comments,
      introduced: [], resolved: 0, status: flagged ? "attention" : "ok",
      note: `${a.comments} of ${a.nonBlank} non-blank lines are comments (${Math.round(ratio * 100)}%). A signal, not a verdict: legitimate documentation looks the same.`,
    });
  } else {
    dims.push({
      name: "Comment density", before: 0, after: 0, introduced: [], resolved: 0, status: "info",
      note: "Not assessed for this file type.",
    });
  }
  return { path, kind, dimensions: dims, notAssessed: NOT_ASSESSED };
}

/** The audit as text an agent and a reviewer can both read. */
export function formatAudit(a: Audit): string {
  const lines = [`**Static audit of \`${a.path}\`** (${a.kind}) — computed by the server, before vs after; nothing was run.`];
  for (const d of a.dimensions) {
    const mark = d.status === "attention" ? "⚠" : d.status === "info" ? "–" : "✓";
    const counts = d.name === "Comment density" ? "" : ` ${d.before} → ${d.after} (+${d.introduced.length} new, ${d.resolved} resolved)`;
    const tail = `${counts}${d.note && d.status !== "ok" ? ` ${d.note}` : ""}`;
    lines.push(`- ${mark} ${d.name}${tail ? `:${tail}` : ""}`);
    for (const f of d.introduced.slice(0, 5)) lines.push(`    - line ${f.line}: ${f.text}`);
  }
  lines.push(`Not assessed: ${a.notAssessed.map((n) => n.name).join(", ")}.`);
  return lines.join("\n");
}
