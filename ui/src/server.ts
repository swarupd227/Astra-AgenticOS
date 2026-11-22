import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import matter from "gray-matter";
import { GoldenStore, catalogBlock, CATALOG_CAP, type ProjectGoldenSelection, type GoldenKind } from "./golden.js";
import { GoldenUsageStore } from "./golden-usage.js";
import { RunPerf, formatPerf, usageOf, type Usage } from "./perf.js";
import {
  EvidenceStore, claimStatus, evidenceFilesFor, freshnessOf, isErrorResult, isEvidenceTool,
  safeJoin, sha256, snapshotFiles, summarizeArgs, unknownEvidenceCitations, type Freshness, type Risk,
} from "./evidence.js";
import { auditChange, formatAudit, proposalsWithoutTests } from "./audit.js";
import { SectionedDoc, applyEdits, sectionKey, type Edit } from "./sections.js";
import {
  CHAPTER_SYSTEM, WRITER_SYSTEM, areaHeadings, enforceDependencies, areaPrompt, carryReview, chapterPrompt, cleanArea, definedIds, draftArea, draftChapter, extractSection, fixPrompt,
  fixChangesPrompt, headingFor, mergeChanges, pool, renumber, renumberNewIds, splitAreas, summarizeDrafts, type Area, type AreaResult, type Chapter, type WriteCall,
} from "./requirement-drafts.js";
import { contentKey, countCitations, countIds, destructiveSave, implausiblyShort } from "./guards.js";
import {
  citationIssues, citationKey, citesTaskPrompt, constructsProhibitedBy, formatCitationReport, formatConflicts, formatDeviation,
  coverageGaps, danglingReferences, duplicateRequirements, formatDuplicateRequirements, fieldRowsAsLabels, dependencyIssues, formatCoverageGaps, formatDanglingReferences, formatOmittedDependencies, formatOmittedItemSentences, formatUncheckedItems, formatQuoteIssues, formatUngroundedFields, omittedDependencies, omittedItemSentences, quoteIssues, ungroundedFields,
   formatDependencyIssues, formatInventedRoles, formatProhibited, formatStrengthIssues, inventedRoles,
  formatDegradedSources, formatItemLedger, isClientDocument, itemLedger, degradedSources, noCheckableCitations, ownDocuments, prohibitedUsed, summarizeItemLedger, requirementBlocks, strengthIssues, templateDeviations, termConflicts, unaddressedConflicts,
  type TermConflict,
} from "./source-checks.js";
import { REVIEW_SCHEMA, REVIEW_SYSTEM, REVIEW_TOOL, ReviewMemory, batchPrompt, coerceReview, formatReview, reviewDocument, sourcesBlock, type AskReviewer, type ReviewReport, type SourceText } from "./source-review.js";
import { formatGapCitations, formatHiddenGaps, formatNarrowedLists, gapCitationIssues, hiddenGaps, narrowedLists } from "./source-gaps.js";
import { NEVER_INDEXED, unzipExcludeArgs, pruneUnindexed, countFiles } from "./workspace.js";
import {
  unprovenClaims,
  unsavedArtifactClaims,
  unqualifiedCompatibility,
  prerequisiteGate,
  requiredInputs,
  stampable,
} from "./verify.js";
import { convertDocument, scanForInjection } from "./doc-convert.js";
import JSZip from "jszip";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths & config
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", ".."); // ui/src -> repo root

// Load ui/.env (gitignored) into process.env — no dependency needed.
function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}
loadDotEnv();
const PORT = Number(process.env.PORT ?? 5173);
let MODEL = process.env.MODEL ?? "claude-sonnet-4-6";
// Large enough that document-generating agents (BRD, big test files) don't get
// truncated mid-tool-argument. Configurable via env.
// Per-response output cap. Every call streams, so the old 16k ceiling (chosen to dodge
// non-streaming HTTP timeouts) was needlessly tight and truncated long deliverables —
// BRDs, migration roadmaps. The models support 128k; 32k is a safe default.
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 32000);
// Azure App Service (and most load balancers/proxies) close a connection that has
// been idle for 230s. Long steps — cloning a big repo, indexing, a slow model turn —
// can exceed that with no bytes on the wire, which the browser reports as a network
// timeout. Everything long-running below sends filler well inside that window.
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 15000);

// Keeps a slow JSON response alive: newlines are legal JSON whitespace *before* the
// value, so the padding is invisible to `await res.json()` on the client.
//
// Writing the first byte locks in the status code, so nothing is written until the
// request has already run longer than one heartbeat — validation errors are all fast
// and keep their real 4xx. Only genuinely long operations get padded, and a failure
// after that point still carries {ok:false, error} which is what the UI reads.
function keepJsonAlive(res: express.Response) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write("\n");
  }, HEARTBEAT_MS);
  timer.unref?.();
  res.on("close", () => clearInterval(timer));
  return {
    send(status: number, payload: unknown) {
      clearInterval(timer);
      if (res.writableEnded) return;
      if (!res.headersSent) res.status(status);
      res.end(JSON.stringify(payload));
    },
  };
}

const DLL = path.join(
  repoRoot,
  "src/SdlcAgents.Mcp/bin/Release/net9.0/SdlcAgents.Mcp.dll"
);
const AGENTS_DIR = path.join(repoRoot, ".github/agents");
// Durable state. Point these at a mounted volume in Docker/Azure so projects,
// history, generated deliverables and cloned repos survive a container restart.
//   STATE_DIR     – projects.json + threads.json
//   ARTIFACTS_DIR – generated deliverables (BRDs, ADRs, test plans…)
//   WORKSPACE_DIR – checkouts of git-backed projects
const STATE_DIR = process.env.STATE_DIR ? path.resolve(process.env.STATE_DIR) : path.join(__dirname, "..");
const ARTIFACTS_ROOT = process.env.ARTIFACTS_DIR
  ? path.resolve(process.env.ARTIFACTS_DIR)
  : path.join(repoRoot, "artifacts");
const WORKSPACE_DIR = process.env.WORKSPACE_DIR
  ? path.resolve(process.env.WORKSPACE_DIR)
  : path.join(repoRoot, "workspace"); // cloned git repos live here
const PROJECTS_FILE = path.join(STATE_DIR, "projects.json");
// Golden Repository — org knowledge, shared across projects (one org-wide library,
// scoped per project by selection). Lives on the same durable share as other state.
const GOLDEN_DIR = process.env.GOLDEN_DIR
  ? path.resolve(process.env.GOLDEN_DIR)
  : path.join(STATE_DIR, "golden");
const golden = new GoldenStore(GOLDEN_DIR);
const goldenUsage = new GoldenUsageStore(GOLDEN_DIR);
// Observations tools returned, and the claims that cite them. Written only by this
// server; on STATE_DIR so it survives a redeploy like everything else durable.
const evidence = new EvidenceStore(path.join(STATE_DIR, "evidence"));

// Running as a hosted container (Azure App Service / Docker)? Then "local folder"
// means a folder on the SERVER, not on the user's PC — the UI needs to say so.
const IS_CLOUD =
  !!process.env.WEBSITE_SITE_NAME ||          // Azure App Service
  !!process.env.CONTAINER_APP_NAME ||         // Azure Container Apps
  fs.existsSync("/.dockerenv");

// Suggested prompts per agent (id -> prompts), drawn from docs/DEMO-SCRIPT.md
const SUGGESTED: Record<string, string[]> = {
  "modernization-net10": [
    "Assess this solution for migration to .NET 10. Inventory the migration blockers, score the effort, and give me a phased roadmap.",
    "What are the System.Web dependencies blocking a move off .NET Framework, and how deep do they reach?",
  ],
  "requirements-brd": [
    "Generate a Business Requirements Document for the shopping cart / checkout tax calculation. Focus on the business rules in the tax and order-total services.",
    "Produce a BRD for customer registration.",
  ],
  "impact-analysis": [
    "I need to change how tax is calculated — specifically TaxService. What is the blast radius and what must I re-test?",
    "What depends on OrderTotalCalculationService?",
  ],
  "architecture-adr": [
    "Give me an architecture overview of this solution.",
    "We want to move tax calculation behind a strategy pattern. Write an ADR and use the impact analysis for the consequences.",
  ],
  "test-generator": [
    "Write NUnit tests for OrderTotalCalculationService, matching the style of the existing tests in Tests/Nop.Services.Tests.",
  ],
  "code-reviewer": [
    "Review Libraries/Nop.Services/Tax/TaxService.cs for correctness and security issues.",
  ],
  "refactor": [
    "Find duplication and code smells in OrderTotalCalculationService and propose safe, behaviour-preserving refactors with before/after.",
    "Are there refactor opportunities in TaxService? Scope each by its callers.",
  ],
  "test-coverage": [
    "What isn't tested in TaxService? Give me the coverage gaps, risk-ranked by usage.",
  ],
  "traceability": [
    "Build a requirements-to-code traceability matrix for shopping-cart tax calculation, and flag any gaps or orphans.",
  ],
  "data-model": [
    "Document the data model for the customer and order domain — entities, keys and relationships — as a Mermaid ERD.",
  ],
  "api-contract": [
    "Generate an OpenAPI contract for the ShoppingCart controller's checkout endpoints.",
  ],
  "code-generation": [
    "Add a tax exemption rule for wholesale customers, following the existing patterns in TaxService and its interface.",
  ],
  "security-threat": [
    "Produce a STRIDE threat model for the checkout and payment flow, grounded in the code.",
  ],
  "orchestrator": [
    "I want to safely change how tax is calculated. Plan and run the right agents end to end, then give me a consolidated report.",
    "Onboard me to this codebase: assess the architecture, key risks and modernization path, using the right agents.",
  ],
  "ci-cd-pipeline": [
    "Generate a CI/CD pipeline for this solution — detect the build system and wire in the Nop test projects.",
  ],
  "observability-rollback": [
    "Produce a deployment readiness pack (golden signals + rollback runbook) for the checkout/order-placement flow.",
  ],
  "dependency-mapper": [
    "Map the project and NuGet dependencies for this solution and flag layering violations and stale packages.",
  ],
  "spec-validator": [
    "Validate the requirements for shopping-cart tax calculation — are they complete, unambiguous and testable, and do they match the code?",
  ],
  "regression": [
    "Review my pending working-tree changes for regression risk and give me a targeted re-test plan.",
    "Assess regression risk for the latest commit (HEAD) — what could it break?",
  ],
  "changelog": [
    "Generate a changelog from the recent commit history, grouped by type with the rationale.",
  ],
  "human-review": [
    "Produce a human-review release gate for the proposed tax-calculation change — checklist, risk tier, required sign-offs and escalation triggers. Use the artifacts already generated.",
  ],
  "dead-code": [
    "Find likely dead code in Nop.Services (unreferenced members and orphaned files), with confidence levels and DI/reflection caveats.",
  ],
  "characterization-tests": [
    "Write characterization (golden-master) tests that pin the current behavior of TaxService before we refactor it.",
  ],
  "config-secrets-auditor": [
    "Audit the web.config files for secrets, connection strings and insecure settings, and give me a remediation plan.",
  ],
  "tech-debt-hotspot": [
    "Rank the tech-debt hotspots in this solution by complexity and coupling, and tell me what to tackle first.",
  ],
  "reliability-auditor": [
    "Audit Nop.Services for error-handling anti-patterns — swallowed exceptions, broad catches and lost stack traces — and rank them by risk.",
  ],
  "performance-auditor": [
    "Find async/performance anti-patterns (sync-over-async, N+1 queries, blocking I/O) in the order and checkout services.",
  ],
  "data-access-risk": [
    "Audit the data-access layer for SQL injection and EF anti-patterns (missing AsNoTracking, N+1, unbounded queries).",
  ],
};

// Repo-agnostic prompts used when the active project isn't the nopCommerce demo.
const GENERIC_SUGGESTED: Record<string, string[]> = {
  "modernization-net10": [
    "Assess this solution for migration to .NET 10. Inventory the migration blockers, score the effort, and give me a phased roadmap.",
  ],
  "requirements-brd": ["Generate a Business Requirements Document for the main feature of this codebase, grounded in the code."],
  "brd-from-documents": ["Write a Business Requirements Document from the input documents in this project. Follow the structure and rules in the prompt I give you, and record gaps and source conflicts instead of resolving them."],
  "impact-analysis": ["Pick a central service in this codebase and analyse the blast radius of changing it."],
  "architecture-adr": ["Give me an architecture overview of this solution."],
  "test-generator": ["Find an untested class and write unit tests for it, matching the existing test style."],
  "code-reviewer": ["Review the most complex file in this codebase for correctness and security issues."],
  "refactor": ["Find duplication and code smells in this codebase and propose safe, behaviour-preserving refactors."],
  "test-coverage": ["What are the biggest test-coverage gaps in this codebase, ranked by risk?"],
  "traceability": ["Build a requirements-to-code traceability matrix for a key feature of this codebase."],
  "data-model": ["Reverse-engineer the data model (entities, keys, relationships) as a Mermaid ERD."],
  "api-contract": ["Generate an OpenAPI contract for the main controller in this codebase."],
  "code-generation": ["Implement a small, well-scoped enhancement following the codebase's existing conventions."],
  "security-threat": ["Produce a STRIDE threat model for a security-sensitive flow in this codebase."],
  "orchestrator": ["Plan and run the right agents to accomplish a goal — e.g. assess this codebase end to end."],
  "ci-cd-pipeline": ["Generate a CI/CD pipeline for this solution, matched to its build system and test projects."],
  "observability-rollback": ["Produce a deployment readiness pack (golden signals + rollback runbook) for a key flow."],
  "dependency-mapper": ["Map the project + NuGet dependencies and flag layering violations and stale packages."],
  "spec-validator": ["Validate the requirements for a key feature — complete, unambiguous, testable, and consistent with the code?"],
  "regression": ["Review the pending changes (or the latest commit) for regression risk and give a targeted re-test plan."],
  "changelog": ["Generate a changelog from the recent commit history, grouped by type with rationale."],
  "human-review": ["Produce a human-review release gate (checklist, risk tier, sign-offs, escalation) for the latest change, using available artifacts."],
  "dead-code": ["Find likely dead code (unreferenced members, orphaned files) with confidence levels and DI/reflection caveats."],
  "characterization-tests": ["Write characterization (golden-master) tests pinning the current behavior of a key class before refactoring."],
  "config-secrets-auditor": ["Audit the config files for secrets, connection strings and insecure settings, with a remediation plan."],
  "tech-debt-hotspot": ["Rank the tech-debt hotspots by complexity and coupling and tell me what to tackle first."],
  "reliability-auditor": ["Audit for error-handling anti-patterns (swallowed exceptions, broad catches, lost stack traces), ranked by risk."],
  "performance-auditor": ["Find async/performance anti-patterns (sync-over-async, N+1 queries, blocking I/O) in the hot paths."],
  "data-access-risk": ["Audit the data-access layer for SQL injection and EF anti-patterns."],
};

// ---------------------------------------------------------------------------
// Agent personas (reused from .github/agents/*.agent.md)
// ---------------------------------------------------------------------------
interface Agent {
  id: string;
  name: string;
  description: string;
  tools: string[];
  systemPrompt: string;
}

function loadAgents(): Agent[] {
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".agent.md"))
    .map((f) => {
      const raw = fs.readFileSync(path.join(AGENTS_DIR, f), "utf8");
      const { data, content } = matter(raw);
      return {
        id: f.replace(".agent.md", ""),
        name: data.name ?? f,
        description: data.description ?? "",
        tools: Array.isArray(data.tools) ? data.tools : [],
        systemPrompt: content.trim(),
      };
    });
}

// ---------------------------------------------------------------------------
// Projects — a project = a source root (local folder or cloned git repo) that
// the MCP server indexes. The active project is what the agents run against.
// ---------------------------------------------------------------------------
interface Project {
  id: string;
  name: string;
  /** `documents`: no code at all — the project is a set of input documents (see /inputs). */
  type: "local" | "git" | "upload" | "documents";
  sourceRoot: string; // absolute path the MCP server indexes
  repoUrl?: string;
  subPath?: string;
  artifactsDir: string;
  createdAt: string;
  /** Which Golden Repository items this project's agents may see. Defaults to all. */
  golden?: ProjectGoldenSelection;
  /**
   * Review scope. When both are set and differ, agents are told to confine
   * themselves to `base...branch` — the developer's actual change — rather than
   * the whole repository. Unset means review everything.
   */
  branch?: string;
  baseBranch?: string;
}
let projects: Project[] = [];
/** Where a brand-new session starts. Persisted, so a restart is not a surprise. */
let defaultProjectId: string | null = null;

const DEMO_ID = "nopcommerce";
function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
}
function newId(name: string) {
  return `${slug(name)}-${crypto.randomBytes(3).toString("hex")}`;
}
function activeProject(): Project | undefined {
  return projects.find((p) => p.id === defaultProjectId);
}

/**
 * A project that can actually be loaded.
 *
 * Falling back to the demo looked safe until the cloud, where the demo codebase is not
 * in the image at all. Deleting a project therefore left every new session pointed at
 * `/app/demo/nopCommerce/src`, which does not exist, and the app opened on
 * "Source root not found" — a broken deployment as far as anyone arriving could tell.
 * Prefer the most recent project whose source root is really on disk.
 */
function fallbackProjectId(exclude: string): string | null {
  const usable = projects.filter((p) => p.id !== exclude && fs.existsSync(p.sourceRoot));
  return usable.length ? usable[usable.length - 1].id : null;
}

/**
 * Where a new session starts: the configured default when it is loadable, otherwise
 * anything that is. Boot already declines to activate a project whose source is
 * missing, but it left the default null and sessions fell straight back to the demo —
 * the very project it had just refused. In a cloud image the demo's source is never
 * present, so every arriving user met an error on a deployment holding twenty
 * perfectly good projects.
 */
function startingProjectId(): string {
  const preferred = projects.find((p) => p.id === defaultProjectId);
  if (preferred && fs.existsSync(preferred.sourceRoot)) return preferred.id;
  return fallbackProjectId(defaultProjectId ?? "") ?? DEMO_ID;
}
function demoProject(): Project {
  return {
    id: DEMO_ID,
    name: "nopCommerce 3.90 (demo)",
    type: "local",
    sourceRoot: path.join(repoRoot, "demo/nopCommerce/src"),
    // Own subdir (not the shared root) so its artifact list doesn't recurse into
    // every other project's folder — that caused cross-project artifact bleed.
    artifactsDir: path.join(ARTIFACTS_ROOT, DEMO_ID),
    createdAt: new Date().toISOString(),
  };
}
function loadProjects() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
    projects = Array.isArray(raw.projects) ? raw.projects : [];
    defaultProjectId = raw.activeProjectId ?? null;
  } catch {
    projects = [];
  }
  if (!projects.some((p) => p.id === DEMO_ID)) projects.unshift(demoProject());
  // Migrate a previously-persisted demo that pointed at the shared artifacts root.
  const demo = projects.find((p) => p.id === DEMO_ID);
  if (demo && path.resolve(demo.artifactsDir) === path.resolve(ARTIFACTS_ROOT)) {
    demo.artifactsDir = path.join(ARTIFACTS_ROOT, DEMO_ID);
  }
  // Rebase artifact folders if ARTIFACTS_DIR has moved (e.g. a deploy that switched
  // from the image-local path to a mounted volume). Every artifactsDir is
  // <root>/<leaf>, so re-parenting the leaf is enough.
  for (const p of projects) {
    if (!p.artifactsDir) continue;
    if (path.resolve(path.dirname(p.artifactsDir)) !== path.resolve(ARTIFACTS_ROOT)) {
      p.artifactsDir = path.join(ARTIFACTS_ROOT, path.basename(p.artifactsDir));
    }
  }

  // Docker / mounted-workspace seed: if SEED_PROJECT_ROOT points at real source,
  // add it as a project and make it active by default (the mounted code to analyse).
  const seedRoot = process.env.SEED_PROJECT_ROOT;
  if (seedRoot && fs.existsSync(seedRoot)) {
    if (!projects.some((p) => p.id === "workspace")) {
      // Keep names distinguishable — a seeded project sharing the demo's name is confusing.
      let seedName = process.env.SEED_PROJECT_NAME || path.basename(path.resolve(seedRoot)) || "Workspace";
      if (projects.some((p) => p.name === seedName)) seedName = `${seedName} — mounted`;
      projects.unshift({
        id: "workspace",
        name: seedName,
        type: "local",
        sourceRoot: path.resolve(seedRoot),
        artifactsDir: path.join(ARTIFACTS_ROOT, "workspace"),
        createdAt: new Date().toISOString(),
      });
    }
    if (!defaultProjectId || defaultProjectId === DEMO_ID) defaultProjectId = "workspace";
  }

  if (!defaultProjectId || !projects.some((p) => p.id === defaultProjectId)) defaultProjectId = DEMO_ID;

  // If the chosen project's source isn't on disk (e.g. the bundled demo in a cloud image,
  // where nothing is mounted), don't activate it — that would surface a scary "MCP error".
  // Leave no active project so the UI shows the "add a project" onboarding instead.
  const act = projects.find((p) => p.id === defaultProjectId);
  if (act && !fs.existsSync(act.sourceRoot)) {
    console.error(`[projects] source root missing for "${act.name}" (${act.sourceRoot}) — starting with no active project.`);
    defaultProjectId = null;
  }
}
function saveProjects() {
  try {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify({ activeProjectId: defaultProjectId, projects }, null, 2));
  } catch (e) {
    console.error("[projects] save failed:", (e as Error).message);
  }
}
function publicProject(p: Project) {
  return {
    id: p.id, name: p.name, type: p.type, sourceRoot: p.sourceRoot, repoUrl: p.repoUrl, createdAt: p.createdAt,
    // false when the code isn't on disk (e.g. the bundled demo inside a cloud image) —
    // the UI greys these out instead of letting you pick one that will fail.
    available: fs.existsSync(p.sourceRoot),
  };
}

// ---------------------------------------------------------------------------
// Conversation threads — per project, persisted to disk so they survive a
// refresh/restart, and replayed to the model so follow-ups have memory.
// ---------------------------------------------------------------------------
interface ThreadMsg { role: "user" | "assistant"; text: string; at: string }
interface Thread {
  id: string; projectId: string; agentId: string; agentName: string;
  title: string; createdAt: string; updatedAt: string; messages: ThreadMsg[];
}
const THREADS_FILE = path.join(STATE_DIR, "threads.json");
// How many past messages to replay as context (keeps token cost bounded).
const MEMORY_MESSAGES = Number(process.env.MEMORY_MESSAGES ?? 10);
let threads: Thread[] = [];

function loadThreads() {
  try {
    const raw = JSON.parse(fs.readFileSync(THREADS_FILE, "utf8"));
    threads = Array.isArray(raw.threads) ? raw.threads : [];
  } catch { threads = []; }
}
function saveThreads() {
  try { fs.writeFileSync(THREADS_FILE, JSON.stringify({ threads }, null, 2)); }
  catch (e) { console.error("[threads] save failed:", (e as Error).message); }
}
function threadSummary(t: Thread) {
  return { id: t.id, agentId: t.agentId, agentName: t.agentName, title: t.title, updatedAt: t.updatedAt, messages: t.messages.length };
}

// ---------------------------------------------------------------------------
// MCP workspaces — one C# server per project, pooled.
//
// These used to be four module globals: one client, one tool list, one active
// project id, shared by every request. With more than one person using ASTRA that
// silently produced wrong answers rather than errors — whoever switched project
// last won, and everyone else's next run analysed a codebase they had not chosen.
// Switching also closed the running server out from under anyone mid-answer.
//
// It is a plausible reading of Round 2's reproducibility finding, where four
// different project names turned up across evidence fields for runs that were
// supposed to be about one codebase.
//
// So: a workspace per project, kept warm and reused, and each browser session
// choosing which one it is looking at.
// ---------------------------------------------------------------------------
/** Everything a run needs to know about which codebase it is working on. */
type RunContext = { project: Project | null; ws: Workspace };

type Workspace = {
  projectId: string;
  client?: Client;
  tools: Anthropic.Tool[];
  ready: boolean;
  error: string | null;
  lastUsed: number;
  /** In-flight startup, so ten simultaneous requests spawn one server, not ten. */
  opening?: Promise<void>;
};

const workspaces = new Map<string, Workspace>();

/**
 * Each server holds a parsed index of a whole repository in memory, so this is a
 * memory ceiling, not a tuning knob. Least-recently-used is evicted; reopening
 * costs an index rebuild, which is why idle ones are kept rather than closed.
 */
const MAX_WORKSPACES = Number(process.env.MAX_WORKSPACES ?? 3);

async function closeWorkspace(ws: Workspace) {
  workspaces.delete(ws.projectId);
  if (ws.client) { try { await ws.client.close(); } catch { /* already gone */ } }
  console.error(`[mcp] closed workspace "${ws.projectId}"`);
}

async function evictIfNeeded(keep: string) {
  while (workspaces.size > MAX_WORKSPACES) {
    const victim = [...workspaces.values()]
      .filter((w) => w.projectId !== keep && !w.opening)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!victim) return;                     // everything else is busy starting
    await closeWorkspace(victim);
  }
}

async function connectMcp(project: Project, ws: Workspace) {
  if (!fs.existsSync(DLL)) {
    throw new Error(`MCP server DLL not found at ${DLL}. Run ./scripts/setup.ps1 (builds Release) first.`);
  }
  if (!fs.existsSync(project.sourceRoot)) {
    throw new Error(`Source root not found: ${project.sourceRoot}`);
  }
  ws.ready = false;
  ws.error = null;
  ws.tools = [];
  fs.mkdirSync(project.artifactsDir, { recursive: true });

  const transport = new StdioClientTransport({
    command: "dotnet",
    args: [DLL],
    env: {
      ...(process.env as Record<string, string>),
      NOPCOMMERCE_ROOT: project.sourceRoot, // the C# server indexes this root
      ARTIFACTS_DIR: project.artifactsDir,
      // Golden Repository: the store plus THIS project's selection. Passing the
      // resolved id list (rather than the rule) makes the project boundary explicit —
      // the MCP server can only ever see items this project selected.
      GOLDEN_DIR,
      GOLDEN_ITEMS: golden.selectedFor(project.golden, project.id).map((i) => i.id).join(","),
    },
  });
  const client = new Client({ name: "astra-agenticos-ui", version: "2.0.0" });
  await client.connect(transport);
  ws.client = client;

  const listed = await client.listTools();
  ws.tools = listed.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  console.error(`[mcp] connected to "${project.name}" (${project.sourceRoot}) — ${ws.tools.length} tools`);
  ws.ready = true;

}

/**
 * Warm the index so the first real prompt is snappy. This is also where a large repo
 * pays its one-off parse cost — if it times out here the agent inherits the problem,
 * so use the same generous budget as a real tool call and say so loudly.
 */
async function warmIndex(project: Project, ws: Workspace) {
  if (!ws.client) return;
  try {
    const t0 = Date.now();
    await ws.client.callTool({ name: "solution_overview", arguments: {} }, undefined, { timeout: MCP_TIMEOUT_MS });
    console.error(`[mcp] index warmed in ${Math.round((Date.now() - t0) / 1000)}s.`);
  } catch (e) {
    console.error(
      `[mcp] WARMUP FAILED for "${project.name}": ${(e as Error).message}\n` +
      `      The first tool call an agent makes will pay the indexing cost and may fail the same way. ` +
      `Raise MCP_TIMEOUT_MS (currently ${MCP_TIMEOUT_MS}ms) if this is a very large repository.`
    );
  }
}

/**
 * The workspace for a project, opening it if necessary.
 *
 * Never throws for a failed open — the error is recorded on the workspace so the
 * caller can report "this project could not be loaded" without taking down a
 * request that was only asking about a different one.
 */
function openWorkspace(projectId: string): Workspace {
  const existing = workspaces.get(projectId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }

  const project = projects.find((p) => p.id === projectId);
  const ws: Workspace = { projectId, tools: [], ready: false, error: null, lastUsed: Date.now() };
  workspaces.set(projectId, ws);

  if (!project) {
    ws.error = `Unknown project: ${projectId}`;
    return ws;
  }

  ws.opening = (async () => {
    const t0 = Date.now();
    let connectMs = 0;
    try {
      await connectMcp(project, ws);
      connectMs = Date.now() - t0;
      await warmIndex(project, ws);
    } catch (e) {
      ws.error = (e as Error).message;
      console.error(`[mcp] could not open "${project.name}": ${ws.error}`);
    } finally {
      ws.opening = undefined;
      // How long a project takes to become usable is the number behind every
      // complaint that the app "hangs on startup".
      recordDiag("workspaces", {
        project: project.id,
        connectSec: Number((connectMs / 1000).toFixed(1)),
        indexSec: Number(((Date.now() - t0 - connectMs) / 1000).toFixed(1)),
        totalSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
        tools: ws.tools.length,
        error: ws.error,
      });
      evictIfNeeded(projectId).catch(() => { /* eviction is best effort */ });
    }
  })();

  return ws;
}

/**
 * Wait for a workspace to finish opening.
 *
 * Only for callers that genuinely cannot proceed without it — creating a project,
 * or explicitly switching to one. Indexing a large repository off the mounted share
 * can take ten minutes or more, and anything that merely *reports* state must use
 * openWorkspace instead: /api/health blocked for the full ten minutes on a cold
 * container while /api/projects answered in nine seconds, which reads as an outage.
 */
async function workspaceFor(projectId: string): Promise<Workspace> {
  const ws = openWorkspace(projectId);
  if (ws.opening) await ws.opening;
  return ws;
}

/** Re-open a project's workspace in place — used after its source or scope changes. */
async function reopenWorkspace(projectId: string) {
  const existing = workspaces.get(projectId);
  if (existing) await closeWorkspace(existing);
  await workspaceFor(projectId);
}

async function activateProject(id: string) {
  const p = projects.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown project: ${id}`);
  defaultProjectId = id;          // what a brand-new session lands on
  saveProjects();
  const ws = await workspaceFor(id);
  if (ws.error) throw new Error(ws.error);
}

// ---------------------------------------------------------------------------
// Sessions — which project this browser is looking at.
//
// Not authentication and not a security boundary: an opaque id in a cookie, so two
// people on the same deployment can hold different projects open. Without it the
// second person silently inherits the first person's choice.
// ---------------------------------------------------------------------------
const SESSION_COOKIE = "astra_sid";
const sessions = new Map<string, { projectId: string; lastSeen: number }>();

function readCookie(req: express.Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/**
 * The session for this request, minting one if the browser has not got a cookie yet.
 * A new session starts on whatever project was last activated, so a single user sees
 * exactly the behaviour they had before sessions existed.
 */
function sessionOf(req: express.Request, res: express.Response) {
  let id = readCookie(req, SESSION_COOKIE);
  if (!id || !sessions.has(id)) {
    if (!id) {
      id = crypto.randomUUID();
      // No Secure flag: the app is also served over plain http in local development,
      // and a Secure cookie would simply never be stored there.
      res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    }
    sessions.set(id, { projectId: startingProjectId(), lastSeen: Date.now() });
  }
  const s = sessions.get(id)!;
  s.lastSeen = Date.now();
  // A project deleted by someone else must not strand this session on it.
  if (!projects.some((p) => p.id === s.projectId)) s.projectId = startingProjectId();
  return { id, state: s };
}

/** As contextOf, but shaped for a run — callers check ws.ready before using it. */
function runContextOf(req: express.Request, res: express.Response): RunContext {
  const { project, ws } = contextOf(req, res);
  return { project, ws: ws ?? { projectId: "", tools: [], ready: false, error: "No project loaded.", lastUsed: Date.now() } };
}

/**
 * The project this request is about, and its workspace.
 *
 * Deliberately does not wait for the workspace to finish opening. Callers report
 * "still starting" from `ws.ready`, which is what they did before workspaces existed —
 * blocking here made every endpoint hostage to a cold index, and a health check that
 * hangs for ten minutes is indistinguishable from a dead server.
 */
function contextOf(req: express.Request, res: express.Response) {
  const { state } = sessionOf(req, res);
  const project = projects.find((p) => p.id === state.projectId) ?? null;
  const ws = project ? openWorkspace(project.id) : null;
  return { project, ws };
}

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

/** The repo root for a project, or null when it isn't a git checkout. */
async function repoRootOf(p: Project): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", p.sourceRoot, "rev-parse", "--show-toplevel"],
      { timeout: 20000, env: GIT_ENV });
    return stdout.trim() || null;
  } catch { return null; }
}

/** Branch names in the checkout (remote-tracking names normalised), plus the one currently out. */
async function gitBranches(root: string): Promise<{ branches: string[]; current: string }> {
  const run = async (args: string[]) =>
    (await execFileP("git", ["-C", root, ...args], { timeout: 20000, env: GIT_ENV })).stdout;

  let current = "";
  try { current = (await run(["rev-parse", "--abbrev-ref", "HEAD"])).trim(); } catch { /* detached or no repo */ }

  const names = new Set<string>();
  try {
    for (const raw of (await run(["branch", "-a", "--format=%(refname:short)"])).split("\n")) {
      // `origin/main` and `main` are the same branch to a developer; collapse them
      // so the picker doesn't show every branch twice.
      const b = raw.trim().replace(/^origin\//, "");
      if (b && b !== "HEAD" && !b.includes("->")) names.add(b);
    }
  } catch { /* leave the list empty — the UI degrades to "whole repo" */ }
  if (current && current !== "HEAD") names.add(current);

  return { branches: [...names].sort(), current };
}

/**
 * Which project, which repository, which commit.
 *
 * Round 2 could not reconcile its own evidence: "AstraOSTesting, Testing,
 * Insurity.Platform.Foundation, and ins-project-paradigm-backend appear in different
 * evidence fields and are not assumed equivalent." Nothing in a response said which UI
 * project it came from, what that project actually points at, or what was checked out
 * at the time — so a finding could not be tied to a commit, and an artifact could not
 * be traced back to the run that produced it.
 *
 * Cheap to gather and worth gathering even when parts are unknown: a blank commit is
 * itself the finding for a project that is not a git checkout.
 */
type RunIdentity = {
  runId: string;
  at: string;
  project: string;        // what the UI shows
  projectId: string;      // what it is called on disk
  repo: string;           // where the code actually came from
  branch: string;
  commit: string;         // short SHA
  scope: string;          // review range, or "whole repository"
  agent: string;
  model: string;
  tools: number;
};

let runSeq = 0;
/** Identity of the run in flight, shared with any sub-agents it delegates to. */
let currentRun: RunIdentity | null = null;

async function runIdentity(project: Project | null, agentName: string, toolCount: number): Promise<RunIdentity> {
  const p = project;
  const id = `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${(++runSeq).toString().padStart(3, "0")}`;

  let branch = "", commit = "";
  if (p) {
    const root = await repoRootOf(p);
    if (root) {
      const q = async (args: string[]) => {
        try { return (await execFileP("git", ["-C", root, ...args], { timeout: 15000, env: GIT_ENV })).stdout.trim(); }
        catch { return ""; }
      };
      branch = await q(["rev-parse", "--abbrev-ref", "HEAD"]);
      commit = await q(["rev-parse", "--short", "HEAD"]);
    }
  }

  const head = p?.branch?.trim(), base = p?.baseBranch?.trim();
  return {
    runId: id,
    at: new Date().toISOString(),
    project: p?.name ?? "(none)",
    projectId: p?.id ?? "",
    repo: p?.repoUrl || p?.sourceRoot || "",
    branch,
    commit,
    scope: head && base && head !== base ? `${base}...${head}` : "whole repository",
    agent: agentName,
    model: MODEL,
    tools: toolCount,
  };
}

/** One line a tester can paste into an evidence field without transcribing it. */
function identityFooter(r: RunIdentity): string {
  const bits = [
    `**${r.project}** (\`${r.projectId}\`)`,
    r.repo ? `repo \`${r.repo}\`` : "no repository",
    r.commit ? `\`${r.branch}\` @ \`${r.commit}\`` : "not a git checkout",
    `scope ${r.scope}`,
    `${r.agent} · ${r.model} · ${r.tools} tools`,
    `run \`${r.runId}\``,
  ];
  return `\n\n---\n_Run identity — ${bits.join(" · ")}_`;
}

/**
 * `base...head` needs the commit where the branch split off, and a shallow clone
 * usually doesn't have it — a branch cut more than 50 commits ago resolves to
 * "no merge base". Deepen until it does, rather than quietly falling back to
 * `base..head`, which would report every commit that landed on the base branch
 * since as if the developer had written it.
 */
async function ensureMergeBase(root: string, base: string, head: string): Promise<boolean> {
  const found = async () => {
    try {
      await execFileP("git", ["-C", root, "merge-base", base, head], { timeout: 20000, env: GIT_ENV });
      return true;
    } catch { return false; }
  };
  if (await found()) return true;

  for (const args of [["fetch", "--deepen", "500", "--quiet"], ["fetch", "--unshallow", "--quiet"]]) {
    // Either can fail harmlessly: --unshallow errors on an already-complete repo,
    // and both fail when the remote is unreachable. The check below is the truth.
    try { await execFileP("git", ["-C", root, ...args], { timeout: 300000, env: GIT_ENV }); } catch { /* see above */ }
    if (await found()) return true;
  }
  return false;
}

/**
 * The instruction that turns "review this repo" into "review my change".
 *
 * `base...branch` (three dots) is deliberate: it diffs against the point the
 * branch diverged, so unrelated commits landing on main afterwards don't show up
 * as the developer's work. Two dots would blame them for everyone else's changes.
 */
function reviewScopeBlock(project: Project | null): string {
  const p = project;
  const head = p?.branch?.trim();
  const base = p?.baseBranch?.trim();
  if (!p || !head || !base || head === base) return "";

  return `\n---\n## Review scope — this run is about one change, not the whole repository\n` +
    `The user is working on branch \`${head}\` and reviewing it against \`${base}\`.\n` +
    `Call \`git_diff\` with ref \`${base}...${head}\` to see exactly what changed, and keep your ` +
    `findings to those changes. Read the wider codebase only to judge whether a change is safe — ` +
    `do not report pre-existing issues in untouched files as if they were part of this change.\n` +
    `If that range cannot be resolved, say so and stop; do not silently review everything instead.`;
}

// The MCP SDK defaults to a 60s per-call timeout. That is fine for a warm index but
// not for the FIRST call against a large repo, which pays for the whole parse —
// nopCommerce (3,901 files) blew straight through it and the agent saw
// "MCP error -32001: Request timed out" as its opening move.
const MCP_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS ?? 10 * 60 * 1000);

async function callMcpTool(ws: Workspace, name: string, args: Record<string, unknown>) {
  if (!ws.client) throw new Error(ws.error ?? "No project loaded / MCP server not connected.");
  const res: any = await ws.client.callTool({ name, arguments: args }, undefined, { timeout: MCP_TIMEOUT_MS });
  const text = (res.content ?? [])
    .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
    .join("\n");
  return text || "(no output)";
}

/**
 * Audit a proposal the moment it is made, so none exists without one. The server does
 * this, not the agent: it compares the real file as it is now against the proposed
 * content, saves the result next to the proposal, and records it in the evidence
 * ledger against the file's current hash — so the audit goes stale if the file moves.
 * Fails loudly: a proposal whose audit could not run says so in its own result.
 */
async function auditProposal(
  ws: Workspace, project: Project | null, args: Record<string, unknown>, result: string,
  ctx: { runId: string; commit: string; agentId: string }
): Promise<string> {
  try {
    const root = project?.sourceRoot;
    if (!root) throw new Error("the project has no source root to compare against");
    const rel = String(args.targetPath ?? "").trim();
    const kind = args.kind === "create" ? "create" : "modify";
    let before = "";
    if (kind === "modify") {
      const full = safeJoin(root, rel);
      if (!full) throw new Error("target path escapes the project root");
      before = fs.readFileSync(full, "utf8");
    }
    const audit = auditChange(rel, kind, before, String(args.content ?? ""));

    // The proposal's own result names where its diff went; the audit sits beside it.
    const named = result.match(/Diff saved to `([^`]+)\.diff`/);
    if (named) await callMcpTool(ws, "save_artifact", { name: `${named[1]}.audit.json`, content: JSON.stringify(audit, null, 2) });

    const text = formatAudit(audit);
    const rec = evidence.addObservation({
      runId: ctx.runId, projectId: project!.id, agent: ctx.agentId, tool: "change_audit",
      args: `targetPath=${rel} kind=${kind}`, outputHash: sha256(text), excerpt: text.slice(0, 300),
      commit: ctx.commit, files: snapshotFiles(root, [rel]),
    });
    return `\n\n${text}\n[audit evidence ${rec.id}]`;
  } catch (e) {
    return `\n\n⚠ **Audit could not be completed for this proposal:** ${(e as Error).message}. Treat it as unaudited.`;
  }
}

// ---------------------------------------------------------------------------
// Deliverables written from source documents — checks made while the agent can still
// fix what it saved (see source-checks.ts for what each one does and does not claim).
// ---------------------------------------------------------------------------

/** Every cited source the server can read: Golden items this project sees, and its input documents. */
function citedSources(content: string, project: Project | null, task = ""): Map<string, string> {
  const out = new Map<string, string>();
  // The task prompt is a source like any other: requirements that cite it were exempt from the citation and strength checks.
  if (task.length > 200 && citesTaskPrompt(content)) out.set(citationKey("task prompt"), task);
  const visible = new Map(golden.selectedFor(project?.golden, project?.id).map((i) => [i.id.toUpperCase(), i.id]));
  for (const m of content.matchAll(/GLD-[A-Z]+-\d+/gi)) {
    const id = visible.get(m[0].toUpperCase());
    const text = id ? golden.readContent(id) : null;
    if (id && text) out.set(citationKey(id), text);
  }
  if (project) {
    for (const m of content.matchAll(/inputs\/[^\s,;)\]*]+\.(?:md|txt)/gi)) {
      const file = path.join(inputsDirOf(project), path.basename(m[0]));
      try { out.set(citationKey(`inputs/${path.basename(file)}`), fs.readFileSync(file, "utf8")); } catch { /* cited but absent: counted as unverifiable */ }
    }
  }
  return out;
}

/**
 * Everything an artifact is checked against once saved. Returns null when all is well.
 *
 * Structure and prohibitions apply to every agent. Citations and conflicts only to agents
 * that write from source documents: there, wording is reproduced and a score against the
 * cited text means something; elsewhere an agent paraphrasing a standard would be flagged
 * for doing exactly what it should.
 */
function documentChecks(
  content: string, task: string, agentId: string, project: Project | null, conflicts: TermConflict[], fromDocuments: boolean,
  /** false for one section of a document being built: structure and conflicts only make sense on the whole. */
  whole = true
): string[] {
  const notes: string[] = [];

  // A near-empty document passed every check once, because there was nothing in it to check.
  const short = fromDocuments && whole ? implausiblyShort(content.length) : null;
  if (short) notes.push(short);

  const prohibited = formatProhibited(prohibitedUsed(content, constructsProhibitedBy(task)));
  if (prohibited) notes.push(prohibited);

  if (whole) {
    for (const t of boundTemplates(agentId, project)) {
      const tpl = golden.readContent(t.id);
      const dev = tpl ? templateDeviations(tpl, content) : null;
      const msg = dev ? formatDeviation(dev, `${t.id} (${t.title})`) : null;
      if (msg) notes.push(msg);
    }
  }

  if (fromDocuments) {
    // Requirements written as `| Field | Detail |` tables are read as labelled lines.
    const doc = fieldRowsAsLabels(content);
    const others = new Map<string, string>();
    if (task.length > 200) others.set("task prompt", task);
    const cited = citedSources(content, project, task);
    const report = citationIssues(doc, cited, others);
    const cit = formatCitationReport(report) ?? (whole ? noCheckableCitations(report, content.length) : null);
    if (cit) notes.push(cit);

    const strength = formatStrengthIssues(strengthIssues(doc, cited));
    if (strength) notes.push(strength);

    // What the requirements say about the gaps, decisions and lists in their sources.
    const gapRefs = formatGapCitations(gapCitationIssues(doc, cited));
    if (gapRefs) notes.push(gapRefs);
    const hidden = formatHiddenGaps(hiddenGaps(doc, cited));
    if (hidden) notes.push(hidden);
    const narrowed = formatNarrowedLists(narrowedLists(doc, cited));
    if (narrowed) notes.push(narrowed);
    // Sentences of the source item a requirement cites that none of the requirements citing it carries.
    const longItems: string[] = [];
    const itemOmissions = formatOmittedItemSentences(omittedItemSentences(doc, cited, longItems));
    if (itemOmissions) notes.push(itemOmissions);
    // Only on the whole document: an area writer told "not checked" has nothing to fix and would spend a round on it.
    const uncheckedItems = whole ? formatUncheckedItems(longItems) : null;
    if (uncheckedItems) notes.push(uncheckedItems);

    const allSources = documentSources(project, task);
    const sourceTexts = allSources.map((s) => s.text);
    // What the document must carry comes from the task and this project's own documents; reference
    // items in the Golden Repository (code conventions, other products) are material to cite, not obligations.
    const ownTexts = ownSources(allSources).map((s) => s.text);
    const deps = formatDependencyIssues(dependencyIssues(doc, sourceTexts));
    if (deps) notes.push(deps);

    // Pointers into parts of the document that do not exist only make sense to judge on the whole document.
    if (whole) {
      const dangling = formatDanglingReferences(danglingReferences(doc, sourceTexts));
      if (dangling) notes.push(dangling);
      // Areas are written by separate writers; nothing else stops two of them stating the same requirement.
      const dupes = formatDuplicateRequirements(duplicateRequirements(doc));
      if (dupes) notes.push(dupes);
    }

    const roles = formatInventedRoles(inventedRoles(doc, sourceTexts));
    if (roles) notes.push(roles);

    const quotes = formatQuoteIssues(quoteIssues(doc, sourceTexts));
    if (quotes) notes.push(quotes);

    const fields = formatUngroundedFields(ungroundedFields(doc, sourceTexts));
    if (fields) notes.push(fields);

    // What is missing can only be judged on the whole document.
    if (whole) {
      const gaps = formatCoverageGaps(coverageGaps(doc, ownTexts), 12, content.length);
      if (gaps) notes.push(gaps);
      const omitted = formatOmittedDependencies(omittedDependencies(doc, ownTexts));
      if (omitted) notes.push(omitted);
      // Every item of the client's documents accounted for: covered, unresolved, excluded or not covered.
      const ledger = formatItemLedger(itemLedger(doc, clientDocumentMap(allSources)));
      if (ledger) notes.push(ledger);
      // First, not last: a document written without a source it was given is the first thing to know.
      const degraded = formatDegradedSources(sourceDegradation(project, task));
      if (degraded) notes.unshift(degraded);
    }
  }

  if (fromDocuments && whole && conflicts.length) {
    const open = unaddressedConflicts(content, conflicts);
    if (open.length)
      notes.push(
        `⚠ **Source conflicts not addressed:** compare_sources reported ${conflicts.length} term(s) defined in unlike words by different sources, ` +
        `and this document does not record ${open.map((t) => `“${t}”`).join(", ")} as a **Source Conflict Identified** with both wordings quoted. Record each (or say it is not a real conflict), then save again.`
      );
  }
  return notes;
}

/** The checks, worded for the agent that just saved: what to fix. */
function postSaveChecks(
  content: string, task: string, agentId: string, project: Project | null, conflicts: TermConflict[], fromDocuments: boolean
): string | null {
  const notes = documentChecks(content, task, agentId, project, conflicts, fromDocuments);
  return notes.length
    ? `\n\n**Checks the server ran on what you just saved** — fix these and save again (the earlier version is kept):\n\n${notes.join("\n\n")}`
    : null;
}

// Synthetic tools for building a document one section at a time (see sections.ts). Handled here
// because the server owns the composed document: the agent writes a section, the server keeps
// the order, saves the whole, and checks the section while the agent still has it in mind.
function writeSectionTool(): Anthropic.Tool {
  return {
    name: "write_section",
    description:
      "Write ONE section of a document. The server keeps the sections in order, composes the whole document, and saves it — so you never re-send the parts you are not changing. Write a section per call (for a long chapter, one call per sub-topic), then check what comes back: the server checks each section's citations, strength, dependencies and roles immediately. To fix a problem, call write_section again with the same section title; it replaces that section in place and nothing else changes. When all sections are written, call check_document.",
    input_schema: {
      type: "object",
      properties: {
        artifact: { type: "string", description: "File name of the document, ending in .md (for example brd-project.md)." },
        section: { type: "string", description: "Section title, used to order and to replace it later. Keep it identical when rewriting." },
        content: { type: "string", description: "The section in Markdown, normally beginning with its heading." },
        after: { type: "string", description: "Optional: the title of an existing section to insert this one after. Omit to append at the end." },
      },
      required: ["artifact", "section", "content"],
    } as Anthropic.Tool.InputSchema,
  };
}

const PATCH_EDITS = {
  type: "array",
  items: {
    type: "object",
    properties: {
      find: { type: "string", description: "Exact text now in the section. It must appear once." },
      replace: { type: "string", description: "What it becomes." },
    },
    required: ["find", "replace"],
  },
} as const;

function patchSectionTool(): Anthropic.Tool {
  return {
    name: "patch_section",
    description:
      "Change part of a section you already wrote with write_section, without sending the rest of it. To fix a finding, give the exact text to change (`find`) and what it becomes (`replace`); a few edits can go in one call. Each `find` must match exactly one place in the section, so include enough surrounding words to be unique. Use this instead of rewriting the section whenever the fix is a sentence, a field or a requirement — it costs a fraction of a rewrite. All the edits of one section apply or none do. Use write_section when the section needs restructuring or most of it changes. " +
      "To fix several sections, send them in ONE call with `sections` (each with its own `section` and `edits`) instead of one call per section: every call is a round trip that re-reads the whole conversation.",
    input_schema: {
      type: "object",
      properties: {
        artifact: { type: "string", description: "File name of the document, ending in .md." },
        section: { type: "string", description: "Title of the section to change, as it was written. Use with `edits` for a single section." },
        edits: { ...PATCH_EDITS, description: "The changes to that section, applied in order. An empty `replace` deletes the text." },
        sections: {
          type: "array",
          description: "Several sections in one call: each has its own `section` title and `edits`. Use this instead of `section` and `edits` when more than one section needs a fix.",
          items: {
            type: "object",
            properties: { section: { type: "string", description: "Title of the section to change." }, edits: PATCH_EDITS },
            required: ["section", "edits"],
          },
        },
      },
      required: ["artifact"],
    } as Anthropic.Tool.InputSchema,
  };
}

function checkDocumentTool(): Anthropic.Tool {
  return {
    name: "check_document",
    description:
      "Run the whole-document checks on a document built with write_section: structure against any bound template, source conflicts recorded, and every section's citations, strength, dependencies and roles together. Call it once after the last section, fix what it reports by rewriting the affected sections, and call it again.",
    input_schema: {
      type: "object",
      properties: { artifact: { type: "string", description: "File name of the document." } },
      required: ["artifact"],
    } as Anthropic.Tool.InputSchema,
  };
}

type SectionContext = {
  ws: Workspace; project: Project | null; agentId: string; task: string; conflicts: TermConflict[];
  docs: Map<string, SectionedDoc>;
  refused: Set<string>;
  /** Where each document was first saved this run; later writes overwrite it in place. */
  paths: Map<string, string>;
  /** What the independent reviewer has read this run (only check_document uses it). */
  review?: ReviewMemory;
  emit?: (e: any) => void;
  perf?: RunPerf;
  /** check_document only: send the reviewer's findings back to the drafted areas' writers; returns a note when areas changed. */
  refixAreas?: (artifact: string, doc: SectionedDoc, report: ReviewReport | undefined) => Promise<string | null>;
  /** check_document only: the document was drafted in parallel, so the writer of the whole is told what still needs fixing. */
  drafted?: boolean;
};

/** An artifact already on disk, or null when there is none. */
function existingArtifact(project: Project | null, name: string): { length: number; citations: number; ids: number } | null {
  if (!project || !name) return null;
  const full = safeJoin(project.artifactsDir, name);
  if (!full) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
    const text = fs.readFileSync(full, "utf8");
    return { length: text.length, citations: countCitations(text), ids: countIds(text) };
  } catch { return null; }
}

/** The sources, lowercased with punctuation runs as single spaces, for checking quoted sentences; kept per project and task. */
const normalizedSourcesCache = new Map<string, string>();
function normalizedSourcesFor(project: Project | null, task: string): string {
  const k = `${project?.id ?? ""}\u0000${task.length}\u0000${task.slice(0, 200)}`;
  let v = normalizedSourcesCache.get(k);
  if (v === undefined) {
    v = sourcesBlock(draftSources(project, task)).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (normalizedSourcesCache.size > 20) normalizedSourcesCache.clear();
    normalizedSourcesCache.set(k, v);
  }
  return v;
}

async function handleWriteSection(
  ctx: SectionContext, input: Record<string, unknown>
): Promise<{ text: string; saved?: { name: string; content: string; path: string }; isError?: boolean }> {
  const name = String(input.artifact ?? "").trim();
  const section = String(input.section ?? "").trim();
  const content = String(input.content ?? "");
  if (!/\.md$/i.test(name))
    return { isError: true, text: "Refused: `artifact` must be a Markdown file name ending in .md." };
  if (!section) return { isError: true, text: "Refused: a section needs a title." };
  if (!content.trim()) return { isError: true, text: "Refused: the section has no content." };

  let doc = ctx.docs.get(name);
  if (!doc) { doc = new SectionedDoc(); ctx.docs.set(name, doc); }

  // Rewriting a long section as a fragment is refused once, like a whole-document save.
  const before = doc.text(section);
  const refusal = destructiveSave({
    kind: "section", newLen: content.length, prevLen: before ? before.length : null, name: `${name} § ${section}`,
    prevCitations: before ? countCitations(before) : undefined, newCitations: countCitations(content),
    prevIds: before ? countIds(before) : undefined, newIds: countIds(content),
  });
  const key = contentKey(`${name}§${section}`, content);
  if (refusal && !ctx.refused.has(key)) {
    ctx.refused.add(key);
    return { isError: true, text: refusal };
  }

  // Every write of a requirement goes through the Dependencies grammar, not only first drafts: a later patch or fix
  // must not bring back a dependency no source sentence states. A reset claim is kept as an open question.
  const dep = /\*\*Dependencies:\*\*/.test(content) ? enforceDependencies(content, normalizedSourcesFor(ctx.project, ctx.task)) : { text: content, reset: [] as string[] };
  const replaced = doc.set(section, dep.text, String(input.after ?? "") || undefined);
  const composed = doc.compose();

  // The first write of a document this run goes through the normal save, so a version from an
  // earlier run is preserved as .vN. Later writes only change what is still being built, and
  // snapshotting each one left 39 near-identical copies of a single document on disk.
  const body = stampable(name) && currentRun ? `${composed}${identityFooter(currentRun)}` : composed;
  let result: string;
  const known = ctx.paths.get(name);
  if (known) {
    fs.writeFileSync(known, body);
    result = `Updated existing artifact \`${known}\` (${body.length} chars).`;
  } else {
    result = await callMcpTool(ctx.ws, "save_artifact", { name, content: body });
  }
  const where = result.match(/^(?:Saved artifact to|Updated existing artifact|Artifact) `([^`]+)`/);
  if (!where) return { isError: true, text: result };
  ctx.paths.set(name, where[1]);

  const notes = documentChecks(doc.text(section) ?? content, ctx.task, ctx.agentId, ctx.project, ctx.conflicts, true, false);
  const titles = doc.titles();
  return {
    saved: { name, content: composed, path: where[1] },
    text:
      `Section “${section}” ${replaced ? "replaced" : "added"}. The document now has ${titles.length} section${titles.length > 1 ? "s" : ""} ` +
      `(${composed.length.toLocaleString("en-US")} characters), saved to \`${where[1]}\`.\n` +
      `Sections so far: ${titles.join(" · ")}.` +
      (dep.reset.length
        ? `\n\n⚠ **Dependencies reset to “Not Specified” on ${dep.reset.join(", ")}:** no source sentence states them as written. Each claim was kept under Open Questions as “Dependency to confirm”. If a source does state it, put it back with the sentence quoted word for word.`
        : "") +
      (notes.length
        ? `\n\n**Checks on this section** — fix these with patch_section (the exact text to change) — or write_section with the same title if most of the section changes:\n\n${notes.join("\n\n")}`
        : ""),
  };
}

type SectionResult = { text: string; saved?: { name: string; content: string; path: string }; isError?: boolean };

/** One call may patch one section (`section`, `edits`) or several (`sections`); each section is applied and checked on its own. */
async function handlePatchSection(ctx: SectionContext, input: Record<string, unknown>): Promise<SectionResult> {
  const name = String(input.artifact ?? "").trim();
  if (!Array.isArray(input.sections)) return patchOneSection(ctx, name, String(input.section ?? "").trim(), input.edits);
  const parts = (input.sections as { section?: unknown; edits?: unknown }[]).filter((p) => p && typeof p === "object");
  if (!parts.length) return { isError: true, text: "Nothing to patch: `sections` is empty." };
  const out: string[] = [];
  let saved: SectionResult["saved"];
  let applied = 0;
  for (const p of parts) {
    const title = String(p.section ?? "").trim();
    const r = await patchOneSection(ctx, name, title, p.edits);
    if (!r.isError) applied++;
    if (r.saved) saved = r.saved; // each save composes the whole document, so the last one is the latest
    out.push(`**${title || "(no title)"}** — ${r.text}`);
  }
  return { text: `${applied} of ${parts.length} sections patched.\n\n${out.join("\n\n")}`, saved, isError: applied === 0 };
}

async function patchOneSection(ctx: SectionContext, name: string, section: string, rawEdits: unknown): Promise<SectionResult> {
  const doc = ctx.docs.get(name);
  const current = doc?.text(section) ?? null;
  if (current === null)
    return { isError: true, text: `Nothing to patch: no section “${section}” of ${name || "(none)"} has been written with write_section in this run. Write it with write_section first${doc ? ` (sections so far: ${doc.titles().join(" · ")})` : ""}.` };
  const edits = Array.isArray(rawEdits) ? (rawEdits as Edit[]) : [];
  const patched = applyEdits(current, edits);
  if (!patched.ok) return { isError: true, text: `Not patched — ${patched.error} The section is unchanged.` };
  const r = await handleWriteSection(ctx, { artifact: name, section, content: patched.text });
  return { ...r, text: r.isError ? r.text : `Patched “${section}” (${patched.changes} edit${patched.changes > 1 ? "s" : ""}). ${r.text.replace(/^Section “[^”]*” replaced\.\s*/, "")}` };
}

async function handleCheckDocument(ctx: SectionContext, input: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const name = String(input.artifact ?? "").trim();
  const doc = ctx.docs.get(name);
  if (!doc) return { isError: true, text: `No document named ${name || "(none)"} has been built with write_section in this run.` };
  let composed = doc.compose();
  let notes = documentChecks(composed, ctx.task, ctx.agentId, ctx.project, ctx.conflicts, true, true);
  // The second reader: a separate model call that did not write the requirements.
  const rctx = { project: ctx.project, task: ctx.task, memory: ctx.review ?? new ReviewMemory(), emit: ctx.emit, perf: ctx.perf };
  let second = await independentReviewReport(rctx, composed, sectionOfIn(doc));
  // Findings on drafted areas go back to their writers, side by side; what they change is read again, and only what is
  // still open reaches the writer of the whole document.
  let refixNote = "";
  if (ctx.refixAreas) {
    const r = await ctx.refixAreas(name, doc, second.report);
    if (r) {
      refixNote = r;
      composed = doc.compose();
      notes = documentChecks(composed, ctx.task, ctx.agentId, ctx.project, ctx.conflicts, true, true);
      second = await independentReviewReport(rctx, composed, sectionOfIn(doc));
    }
  }
  if (refixNote) notes.unshift(refixNote);
  if (second.text) notes.push(second.text);
  if (doc.citationRewrites)
    notes.push(`ℹ **${doc.citationRewrites} citation(s) were written as files under inputs/ (\`inputs/GLD-…\`) and corrected to the Golden Repository id.** A Golden Repository document is cited by its id, e.g. \`GLD-FS-002@1\`.`);
  // After the sections' own writers have had their rounds, the writer of the whole document fixes what matters and
  // stops: run 23 spent 68 turns (11 minutes) patching minor findings and weak citation matches one at a time.
  if (ctx.drafted || refixNote)
    notes.push(
      `**What to fix now:** every "fail" finding, scope items not covered, references to things the document does not contain, invented roles, and unrecorded source conflicts — batched into as few patch_section calls as you can (one call can carry several sections). ` +
      `"Minor" findings and citations that "only weakly match" are for information: fix one only if it is a single small patch. Then give your final answer.`
    );
  const size = `${doc.titles().length} sections, ${composed.length.toLocaleString("en-US")} characters`;
  return {
    text: notes.length
      ? `**Whole-document checks on ${name}** (${size}) — fix each with patch_section (or rewrite the section with write_section if most of it changes), then check again:\n\n${notes.join("\n\n")}`
      : `The server's whole-document checks found nothing to report on ${name} (${size}). They are heuristics over text, not a judgment that every statement is true.`,
  };
}

// The requirements chapter, written area by area in parallel (see requirement-drafts.ts).
// All the areas of a typical requirements document at once (14 in one client's inputs): one wave of about 3–4 minutes.
const DRAFT_CONCURRENCY = Number(process.env.DRAFT_CONCURRENCY ?? 16);
// Review-and-fix rounds inside each area, run side by side with no barrier between areas. Run 23 had 2, and its writer
// of the whole document then spent 11 minutes patching what was left.
const DRAFT_FIX_ROUNDS = Number(process.env.DRAFT_FIX_ROUNDS ?? 3);
// A further pass at check_document that sends what is still open back to the sections' writers. Run 24: 3 minutes
// (129 s fixing, 61 s re-reading) and the same three failing findings afterwards as before, so it is off by default.
// "fail" (default): only the reviewer's fail findings go back to their areas' writers, as changes, in parallel, so the
// writer of the whole document is left the defects only it can fix. "on": every finding and check, chapters too
// (run 24: 3 minutes, no fewer failures). "off": none.
const DRAFT_REFIX_MODE = (process.env.DRAFT_REFIX ?? "fail") as "off" | "fail" | "on";
const DRAFT_REFIX = DRAFT_REFIX_MODE !== "off";
// Check-and-fix rounds for each chapter writer, stopping as soon as its checks are clean. Run 26's chapters had 2 and
// still carried 31 unverified citations, which the writer of the whole document then cleared in ~50 serial patches.
const DRAFT_CHAPTER_ROUNDS = Number(process.env.DRAFT_CHAPTER_ROUNDS ?? 4);
// No fix round starts after this long: run 28's slowest chapter (689 s) held the whole document up.
const DRAFT_CHAPTER_BUDGET_MS = Number(process.env.DRAFT_CHAPTER_BUDGET_MS ?? 240_000);
// check_document calls in a run whose sections were drafted in parallel: the last one says so, later ones are refused.
// Run 26 called it six times and hit the turn limit patching between them.
const DRAFTED_CHECK_LIMIT = Number(process.env.DRAFTED_CHECK_LIMIT ?? 2);
const DRAFT_MODEL = process.env.DRAFT_MODEL || "";
// What counts as an area of the sources that must have a writer, and when an area is worth splitting (see splitAreas).
const AREA_MIN_CHARS = Number(process.env.AREA_MIN_CHARS ?? 1500);
const SPLIT_MIN_CHARS = Number(process.env.SPLIT_MIN_CHARS ?? 12000);
const NOT_AN_AREA = /(definitions?|glossary|terms|abbreviations?|acronyms?|open (items?|questions?|issues?)|references?|appendix|annex|revision|change log|document (history|control))/i;
const DRAFT_CALL_TIMEOUT_MS = Number(process.env.DRAFT_CALL_TIMEOUT_MS ?? 360_000);

function draftRequirementsTool(): Anthropic.Tool {
  return {
    name: "draft_requirements",
    description:
      "Write the whole requirements chapter in parallel: one writer per area of the sources, each given its area's source section, then checked by the server, read by the independent reviewer and corrected by its writer — all areas side by side. " +
      "Use it instead of writing requirements yourself. Give one area per feature group of the approved scope, each mapped to the heading(s) of the input-document section(s) it comes from (every top-level area of the requirements documents should belong to one area). " +
      "Call it FIRST, right after reading the sources and compare_sources, before writing any other section, so the areas are drafted while you write the rest. " +
      "It returns at once and runs in the background for several minutes; placeholders are inserted into the document where the areas will go. Meanwhile write the document's other chapters with write_section, numbered (\"5.1 …\", \"7. …\"): numbered sections are placed in number order around the requirements chapter. " +
      "Each area is written as: its heading, a Feature analysis table, then requirements in the fixed form (#### REQ-nnn — Name, Requirement Statement, Source Reference, Priority, Dependencies, Open Questions); IDs are numbered across the document by the server. " +
      "Call check_document when your other chapters are done: it waits for the areas and checks the whole document.",
    input_schema: {
      type: "object",
      properties: {
        artifact: { type: "string", description: "File name of the document, ending in .md (the same one you write the other sections to)." },
        chapter: { type: "string", description: "Title of the requirements chapter, e.g. \"6. Existing Requirements\". A short chapter heading section is created with it." },
        intro: { type: "string", description: "Optional: one or two sentences under the chapter heading (how requirements are organised, the format). No requirements here." },
        after: { type: "string", description: "Optional: the title of an existing section to place the chapter after. Omit to place it at the end of what is written so far." },
        outline: { type: "array", items: { type: "string" }, description: "Every top-level section of the document, in the order the task gives them, titled exactly as the task names them (with numbers only if the task numbers them). The server places every section by it, whatever order you write them in." },
        areas: {
          type: "array",
          description: "The areas, in document order.",
          items: {
            type: "object",
            properties: {
              section: { type: "string", description: "Section title, numbered under the chapter, e.g. \"6.1 Billing Methods\"." },
              scope: { type: "string", description: "The approved-scope items this area covers, as the task names them." },
              source_headings: { type: "array", items: { type: "string" }, description: "Heading(s) in the input documents whose sections this area is written from, as they appear there (e.g. \"Billing Methods\"). Empty for a scope item no input document describes (it is written from the task prompt) — do not leave such an item out." },
              task_section: { type: "string", description: "Optional: the heading of the task prompt's own description of this area (e.g. \"BILLING METHODS\")." },
            },
            required: ["section", "scope", "source_headings"],
          },
        },
      },
      required: ["artifact", "chapter", "areas"],
    } as Anthropic.Tool.InputSchema,
  };
}

/**
 * The client's own documents among the sources, with the task: the uploaded inputs, or — for a project that has none and
 * holds its specifications in the Golden Repository — its functional specifications. A user-generated BRD from a project
 * with only GLD-FS items had no area writers at all and was written in one pass (8 of 11 fails were merged items).
 */
const ownSources = ownDocuments;

/** The client's own documents (not the task), keyed as a citation names them: `inputs/x.md` or `GLD-FS-002`. */
function clientDocumentMap(all: { name: string; text: string }[]): Map<string, string> {
  return new Map(ownSources(all).filter((s) => s.name !== "task prompt").map((s) => [citationKey(s.name.split(" ")[0]), s.text]));
}

/** The sources an area writer and its reviewer read: the task and this project's own documents. */
function draftSources(project: Project | null, task: string): SourceText[] {
  return ownSources(documentSources(project, task));
}

/** Put a system prompt in the model's prompt cache before parallel calls start, so they read it rather than each writing it. */
async function warmCache(system: any[], tools?: any[]): Promise<void> {
  try {
    await anthropic.messages.create({
      model: DRAFT_MODEL || MODEL, max_tokens: 1, system, ...(tools ? { tools } : {}),
      messages: [{ role: "user", content: "Reply with OK." }],
    }, { timeout: 120_000, maxRetries: 1 });
  } catch (e) { console.error(`[drafts] cache warm-up failed (continuing): ${(e as Error).message}`); }
}

/**
 * A writer: the sources first, cached, then its brief. Area writers and chapter writers have different briefs but the
 * same cached prefix (no tools, the same sources block), so one warm-up serves every parallel writer.
 */
function writerSystem(sources: SourceText[], rules?: string): any[] {
  return [
    { type: "text", text: sourcesBlock(sources), cache_control: { type: "ephemeral" } },
    ...(rules ? [{ type: "text", text: rules }] : []),
  ];
}
function makeWriter(sources: SourceText[], rules: string, perf?: RunPerf): { system: any[]; write: WriteCall } {
  const system = writerSystem(sources, rules);
  const write: WriteCall = async (messages) => {
    const t0 = Date.now();
    const resp = await anthropic.messages.create({
      model: DRAFT_MODEL || MODEL, max_tokens: 16000, system: system as any, messages,
    }, { timeout: DRAFT_CALL_TIMEOUT_MS, maxRetries: 2 });
    perf?.draftCall(Date.now() - t0, usageOf(resp.usage));
    if (resp.stop_reason === "max_tokens") console.error(`[drafts] an area writer hit the output limit`);
    return resp.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
  };
  return { system, write };
}

type DraftJob = {
  kind: "requirements" | "chapters";
  artifact: string; sections: Set<string>;
  promise: Promise<{ summary: string; saved?: { name: string; content: string; path: string } }>;
  reported: boolean; done: boolean;
  /** Requirements only: correct one area from findings, returning its new text, or null when the fix is unusable. */
  fix?: (section: string, current: string, findings: ReviewReport["findings"], checks: string[]) => Promise<string | null>;
};

/**
 * Validate the areas, put placeholders in the document, and start the areas in the background. Returns the text for the
 * calling agent and the job, or an error.
 */
async function startDraftRequirements(
  ctx: SectionContext & { memory: ReviewMemory }, input: Record<string, unknown>, refusedOnce: Set<string>
): Promise<{ text: string; isError?: boolean; job?: DraftJob }> {
  const artifact = String(input.artifact ?? "").trim();
  const chapter = String(input.chapter ?? "").replace(/^s*#{1,6}s*/, "").trim();
  if (!/\.md$/i.test(artifact)) return { isError: true, text: "Refused: `artifact` must be a Markdown file name ending in .md." };
  if (!chapter) return { isError: true, text: "Refused: give the requirements chapter a title (`chapter`)." };
  const raw = Array.isArray(input.areas) ? (input.areas as any[]) : [];
  let areas: Area[] = raw.filter((a) => a && typeof a === "object").map((a) => ({
    section: String(a.section ?? "").replace(/^s*#{1,6}s*/, "").trim(),
    scope: String(a.scope ?? "").trim(),
    sourceHeadings: (Array.isArray(a.source_headings) ? a.source_headings : [a.source_headings]).map((h: unknown) => String(h ?? "").trim()).filter(Boolean),
    taskSection: a.task_section ? String(a.task_section).trim() : undefined,
  })).filter((a) => a.section);
  if (!areas.length) return { isError: true, text: "Refused: `areas` is empty." };

  const sources = draftSources(ctx.project, ctx.task);
  const available = areaHeadings(sources);
  const extracts = areas.map((a) => a.sourceHeadings.map((h) => ({ h, e: extractSection(sources, h) })));
  const unknown = extracts.flatMap((xs, i) => xs.filter((x) => !x.e).map((x) => `“${x.h}” (area ${areas[i].section})`));
  if (unknown.length)
    return { isError: true, text: `Refused: no heading in the input documents matches ${unknown.join(", ")}. Use the headings as they appear in the sources. A scope item that no input document describes (only the task names it) is still an area: give it \`source_headings: []\` and it is written from the task prompt. The main areas of the input documents are:\n${available.map((a) => `- ${a.title} (${a.source})`).join("\n")}` };
  const used = new Set(extracts.flat().map((x) => sectionKey(x.e!.title)));
  // Only an area with requirement material must have a writer: a glossary, an open-items list or a few lines are
  // sources for the writers, not areas of their own (on a held-out input, forcing them in made requirements of a glossary).
  const substantial = available.filter((a) => !NOT_AN_AREA.test(a.title) && (extractSection(sources, a.title)?.text.length ?? 0) >= AREA_MIN_CHARS);
  const unassigned = substantial.filter((a) => !used.has(sectionKey(a.title)));
  const key = `draft:${artifact}:${unassigned.map((u) => u.title).join("|")}`;
  if (unassigned.length && !refusedOnce.has(key)) {
    refusedOnce.add(key);
    return { isError: true, text: `Not started: these areas of the input documents belong to no area, so their requirements would be missing:\n${unassigned.map((a) => `- ${a.title} (${a.source})`).join("\n")}\n\nAdd them to an area (or a new one). If one is genuinely out of the approved scope, send the same call again and it will start; say so in your answer.` };
  }
  // One writer per source area: an area given several is split, so no single writer becomes the slowest chain.
  const parts = splitAreas(areas, extracts.map((xs) => xs.map((x) => x.e!)), substantial, SPLIT_MIN_CHARS);
  if (parts.split.length) console.error(`[drafts] split into one writer per source area: ${parts.split.join("; ")}`);
  areas = parts.areas;
  const areaExtracts = parts.extracts;

  // Placeholders, so the chapter has its place and the other chapters can be written around it.
  let doc = ctx.docs.get(artifact);
  if (!doc) { doc = new SectionedDoc(); ctx.docs.set(artifact, doc); }
  const intro = String(input.intro ?? "").trim();
  const after = String(input.after ?? "").trim() || undefined;
  if (Array.isArray(input.outline) && input.outline.length) doc.setOutline(input.outline.map((t: unknown) => String(t ?? "")));
  doc.set(chapter, `## ${chapter}${intro ? `\n\n${intro}` : ""}`, after && doc.has(after) ? after : undefined);
  let prev = chapter;
  for (const a of areas.slice(0, -1)) { doc.set(a.section, `### ${a.section}\n\n_Being drafted…_`, prev); prev = a.section; }
  const last = areas[areas.length - 1];
  const first = await handleWriteSection(ctx, { artifact, section: last.section, content: `### ${last.section}\n\n_Being drafted…_`, after: prev });
  if (first.isError) return { isError: true, text: first.text };

  ctx.emit?.({ type: "notice", message: `Drafting ${areas.length} requirement areas in parallel…` });
  const started = Date.now();
  const { write } = makeWriter(sources, WRITER_SYSTEM, ctx.perf);
  const promise = (async () => {
    const reviewerSystem = [{ type: "text", text: REVIEW_SYSTEM }, { type: "text", text: sourcesBlock(sources), cache_control: { type: "ephemeral" } }];
    await Promise.all([warmCache(writerSystem(sources)), SOURCE_REVIEW ? warmCache(reviewerSystem) : Promise.resolve()]);
    const ask = makeReviewer(sources, (ms, u) => ctx.perf?.reviewCall(ms, u));
    const memories = areas.map(() => new ReviewMemory());
    const results = await pool(areas, DRAFT_CONCURRENCY, async (area, i) => {
      try {
        const r = await draftArea({
          area, extracts: areaExtracts[i], write, memory: memories[i], rounds: SOURCE_REVIEW ? DRAFT_FIX_ROUNDS : 0,
          check: (text) => documentChecks(text, ctx.task, ctx.agentId, ctx.project, ctx.conflicts, true, false),
          review: (text, memory) => reviewDocument({ doc: text, sources, memory, ask, batchSize: 6, concurrency: 3, firstAlone: false }),
        });
        ctx.emit?.({ type: "notice", message: `Requirements drafted: ${area.section} (${r.reqs})` });
        console.error(`[drafts] ${area.section}: ${r.reqs} requirements, ${r.fixRounds} fix round(s), ${r.openReview.length} review finding(s) open, ${r.openChecks.length} check(s) open, ${Math.round((Date.now() - started) / 1000)}s${r.note ? ` — ${r.note}` : ""}`);
        if (process.env.DRAFT_DEBUG && ctx.project) {
          try { fs.writeFileSync(path.join(ctx.project.artifactsDir, `draft-${i + 1}.json`), JSON.stringify({ area: r.area, note: r.note, openChecks: r.openChecks, openReview: r.openReview, text: r.text }, null, 1)); } catch { /* debug only */ }
        }
        return r;
      } catch (e) {
        console.error(`[drafts] ${area.section} failed: ${(e as Error).message}`);
        return { area, text: `### ${area.section}\n\n_Not drafted: ${(e as Error).message}_`, reqs: 0, fixRounds: 0, openChecks: [], openReview: [], error: (e as Error).message } as AreaResult;
      }
    });
    // Dependencies: "Not Specified", or a dependency with its verbatim source sentence. Nothing else goes in.
    const normalizedSources = sourcesBlock(sources).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const depResets: string[] = [];
    for (const r of results) {
      const d = enforceDependencies(r.text, normalizedSources);
      if (d.reset.length) {
        r.text = d.text;
        depResets.push(`${r.area.section} (${d.reset.length})`);
        console.error(`[drafts] ${r.area.section}: Dependencies reset to "Not Specified" on ${d.reset.join(", ")} (no verbatim source sentence)`);
      }
    }
    const { texts, ranges } = renumber(results.map((r) => r.text));
    results.forEach((r, i) => carryReview(r.text, texts[i], memories[i], ctx.memory));
    for (let i = 0; i < areas.length - 1; i++) doc!.set(areas[i].section, texts[i]);
    const saved = await handleWriteSection(ctx, { artifact, section: last.section, content: texts[texts.length - 1] });
    const ms = Date.now() - started;
    ctx.perf?.draftPhase(areas.length, ms);
    console.error(`[drafts] ${areas.length} areas, ${ranges.reduce((s, r) => s + r.count, 0)} requirements in ${Math.round(ms / 1000)}s`);
    ctx.emit?.({ type: "notice", message: `All ${areas.length} requirement areas are in the document.` });
    const resetNote = depResets.length
      ? `

⚠ **Dependencies reset to “Not Specified”** where no source sentence states them as written: ${depResets.join(", ")}. Each claim is kept under that requirement's Open Questions as “Dependency to confirm”; restore one only with its source sentence quoted word for word.`
      : "";
    return { summary: summarizeDrafts(results, ranges, ms) + resetNote, saved: saved.saved };
  })();
  // At check_document, what the reviewer still finds in an area goes back to a writer for that area, all areas at once,
  // rather than to the writer of the whole document one patch per turn (run 22: 35 patch turns, 9 minutes).
  const byKey = new Map(areas.map((a, i) => [sectionKey(a.section), { area: a, extracts: areaExtracts[i] }]));
  const fix: DraftJob["fix"] = async (section, current, findings, checks) => {
    const a = byKey.get(sectionKey(section));
    if (!a) return null;
    // Only the changed requirements come back, as in the areas' own rounds.
    const answer = await write([
      { role: "user", content: areaPrompt(a.area, a.extracts) + `\n\n(The requirement IDs in this area are already numbered for the whole document; keep them exactly as they are.)` },
      { role: "assistant", content: current },
      { role: "user", content: fixChangesPrompt(checks, findings) },
    ]);
    const merged = mergeChanges(current, answer);
    if (!merged) return null;
    const out = cleanArea(merged, a.area);
    const before = definedIds(current), after = new Set(definedIds(out));
    const named = new Set(findings.map((f) => f.req));
    if (!after.size || before.some((id) => !after.has(id) && !named.has(id))) return null;
    return out;
  };
  const job: DraftJob = { kind: "requirements", artifact, sections: new Set(areas.map((a) => sectionKey(a.section))), promise, reported: false, done: false, fix };
  promise.finally(() => { job.done = true; }).catch(() => {});
  return {
    job,
    text:
      `Started: ${areas.length} areas are being written in parallel, each from its own source section, then checked, reviewed and corrected (several minutes). ` +
      `Placeholders are in \`${artifact}\` under “${chapter}”.\n\n` +
      `While they run, write the document's other chapters — with draft_chapters for the long ones, write_section for short ones — numbered so they fall into place around the requirements chapter. Do not write requirements for these areas yourself, and do not write or patch the placeholder sections. ` +
      `When the other chapters are done, call check_document: it waits for the areas, puts them in the document, and checks the whole.`,
  };
}

function draftChaptersTool(): Anthropic.Tool {
  return {
    name: "draft_chapters",
    description:
      "Write several chapters of the document in parallel, each by its own writer with all the sources in front of it, then checked by the server and corrected once. Use it for the long chapters that do not need requirement IDs (business objectives, success criteria, target audience, stakeholders, key features, process and context chapters). " +
      "For each give the numbered section title and what it must contain: point to the task's own instructions for it by their heading in the task (e.g. \"Follow the task's 'Success Criteria' instructions\"), and add what the writer must know that the sources do not say (e.g. the objective IDs to align to, if another chapter defines them). " +
      "A chapter made of one entry per feature or per role (key features, target audience, stakeholders) is written fastest as several entries of at most four features or roles each, numbered as sub-sections (\"8.1 Key Features — Billing and Credit\", \"8.2 …\"), with a short entry for the chapter heading itself if it needs an introduction. " +
      "It returns at once; the chapters are written in the background (a few minutes) and placed by their numbers. Call check_document when you are done: it waits for them.",
    input_schema: {
      type: "object",
      properties: {
        artifact: { type: "string", description: "File name of the document, ending in .md." },
        outline: { type: "array", items: { type: "string" }, description: "Optional (if already given to draft_requirements): every top-level section in the task's order and wording." },
        chapters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              section: { type: "string", description: "Numbered section title, e.g. \"5.2 Success Criteria\" or \"6. Key Features\"." },
              instructions: { type: "string", description: "What the chapter must contain, by reference to the task's instructions for it, plus anything the writer needs that is not in the sources." },
            },
            required: ["section", "instructions"],
          },
        },
      },
      required: ["artifact", "chapters"],
    } as Anthropic.Tool.InputSchema,
  };
}

async function startDraftChapters(ctx: SectionContext, input: Record<string, unknown>): Promise<{ text: string; isError?: boolean; job?: DraftJob }> {
  const artifact = String(input.artifact ?? "").trim();
  if (!/\.md$/i.test(artifact)) return { isError: true, text: "Refused: `artifact` must be a Markdown file name ending in .md." };
  const chapters: Chapter[] = (Array.isArray(input.chapters) ? (input.chapters as any[]) : [])
    .filter((c) => c && typeof c === "object")
    .map((c) => ({ section: String(c.section ?? "").replace(/^s*#{1,6}s*/, "").trim(), instructions: String(c.instructions ?? "").trim() }))
    .filter((c) => c.section && c.instructions);
  if (!chapters.length) return { isError: true, text: "Refused: `chapters` is empty (each needs a section title and instructions)." };
  let doc = ctx.docs.get(artifact);
  if (!doc) { doc = new SectionedDoc(); ctx.docs.set(artifact, doc); }
  if (Array.isArray(input.outline) && input.outline.length) doc.setOutline(input.outline.map((t: unknown) => String(t ?? "")));
  for (const c of chapters.slice(0, -1)) doc.set(c.section, `${headingFor(c.section)}\n\n_Being drafted…_`);
  const last = chapters[chapters.length - 1];
  const first = await handleWriteSection(ctx, { artifact, section: last.section, content: `${headingFor(last.section)}\n\n_Being drafted…_` });
  if (first.isError) return { isError: true, text: first.text };

  const sources = draftSources(ctx.project, ctx.task);
  const { write } = makeWriter(sources, CHAPTER_SYSTEM, ctx.perf);
  const started = Date.now();
  ctx.emit?.({ type: "notice", message: `Drafting ${chapters.length} chapters in parallel…` });
  const promise = (async () => {
    await warmCache(writerSystem(sources));
    const results = await pool(chapters, DRAFT_CONCURRENCY, async (chapter) => {
      try {
        const r = await draftChapter({ chapter, write, rounds: DRAFT_CHAPTER_ROUNDS, budgetMs: DRAFT_CHAPTER_BUDGET_MS, check: (text) => documentChecks(text, ctx.task, ctx.agentId, ctx.project, ctx.conflicts, true, false) });
        console.error(`[drafts] chapter ${chapter.section}: ${r.text.length} chars, ${r.fixRounds} fix round(s), ${r.openChecks.length} check(s) open, ${Math.round((Date.now() - started) / 1000)}s`);
        return r;
      } catch (e) {
        console.error(`[drafts] chapter ${chapter.section} failed: ${(e as Error).message}`);
        return { chapter, text: `${headingFor(chapter.section)}\n\n_Not drafted: ${(e as Error).message}_`, openChecks: [] as string[], fixRounds: 0 };
      }
    });
    for (const r of results.slice(0, -1)) doc!.set(r.chapter.section, r.text);
    const lastR = results[results.length - 1];
    const saved = await handleWriteSection(ctx, { artifact, section: lastR.chapter.section, content: lastR.text });
    const ms = Date.now() - started;
    ctx.perf?.draftPhase(0, ms);
    ctx.emit?.({ type: "notice", message: `All ${chapters.length} chapters are in the document.` });
    const rows = results.map((r) => `- **${r.chapter.section}** — ${r.text.length.toLocaleString("en-US")} characters${r.openChecks.length ? `; ${r.openChecks.length} server check(s) still open (check_document lists them)` : ""}`);
    return { summary: `**Chapters drafted in parallel:** ${results.length}, in ${Math.round(ms / 1000)} s.\n\n${rows.join("\n")}`, saved: saved.saved };
  })();
  const byKey = new Map(chapters.map((c) => [sectionKey(c.section), c]));
  const fix: DraftJob["fix"] = async (section, current, _findings, checks) => {
    const c = byKey.get(sectionKey(section));
    if (!c || !checks.length) return null;
    const out = await write([
      { role: "user", content: chapterPrompt(c) },
      { role: "assistant", content: current },
      { role: "user", content: fixPrompt(checks, []).replace("Return the whole area again", "Return the whole chapter again").replace("with the same requirement IDs", "keeping everything the findings do not concern") },
    ]);
    const s = out.replace(/^\s*```(?:markdown|md)?\s*\n/i, "").replace(/\n```\s*$/, "").trim();
    const first = s.search(/^#{1,6}\s/m);
    const text = first > 0 ? s.slice(first) : s;
    return /^#{1,6}\s/.test(text) ? text : null;
  };
  const job: DraftJob = { kind: "chapters", artifact, sections: new Set(chapters.map((c) => sectionKey(c.section))), promise, reported: false, done: false, fix };
  promise.finally(() => { job.done = true; }).catch(() => {});
  return { job, text: `Started: ${chapters.length} chapters are being written in parallel (a few minutes) and will be placed by their numbers in \`${artifact}\`. Do not write or patch them meanwhile. Write anything else that is left, then call check_document: it waits for them.` };
}

/**
 * Hand the reviewer's findings on requirements back to their areas' writers, all areas at once, and put the corrected
 * areas in the document. Returns how many areas were changed.
 */
async function fixAreasFromReview(
  ctx: SectionContext, jobs: DraftJob[], doc: SectionedDoc, artifact: string, report: ReviewReport | undefined
): Promise<{ changed: number; saved?: { name: string; content: string; path: string }; depResets?: string[] }> {
  const sectionOf = sectionOfIn(doc);
  const work: { section: string; job: DraftJob; findings: ReviewReport["findings"]; checks: string[] }[] = [];
  const failsOnly = DRAFT_REFIX_MODE === "fail";
  for (const job of jobs.filter((j) => j.fix && (!failsOnly || j.kind === "requirements"))) {
    for (const title of doc.titles().filter((t) => job.sections.has(sectionKey(t)))) {
      const current = doc.text(title) ?? "";
      const findings = job.kind === "requirements" ? (report?.findings ?? []).filter((f) => sectionKey(sectionOf(f.req)) === sectionKey(title) && (!failsOnly || f.verdict === "fail")) : [];
      const checks = failsOnly ? [] : documentChecks(current, ctx.task, ctx.agentId, ctx.project, ctx.conflicts, true, false);
      if (findings.length || checks.length) work.push({ section: title, job, findings, checks });
    }
  }
  if (!work.length) return { changed: 0 };
  ctx.emit?.({ type: "notice", message: `Sending what the checks and the reviewer found back to ${work.length} section writer(s)…` });
  const started = Date.now();
  const out = await pool(work, DRAFT_CONCURRENCY, async ({ section, job, findings, checks }) => {
    try {
      return { section, text: await job.fix!(section, doc.text(section) ?? "", findings, checks) };
    } catch (e) { console.error(`[drafts] fix of ${section} failed: ${(e as Error).message}`); return { section, text: null }; }
  });
  const byArea = { size: work.length };
  // IDs are global by now. A fix may add a requirement "with the next unused ID" as its area sees it, which is the next
  // area's first ID; such an ID is moved past every ID the document defines.
  const reqNo = (id: string) => Number(id.replace(/\D/g, ""));
  let next = Math.max(0, ...definedIds(doc.compose()).map(reqNo)) + 1;
  const depResets: string[] = [];
  for (const o of out) {
    if (!o.text) continue;
    const elsewhere = doc.titles().filter((t) => sectionKey(t) !== sectionKey(o.section)).flatMap((t) => definedIds(doc.text(t) ?? ""));
    const rn = renumberNewIds(o.text, definedIds(doc.text(o.section) ?? ""), elsewhere, next);
    next = rn.next;
    if (rn.moved.size) {
      o.text = rn.text;
      console.error(`[drafts] ${o.section}: new ID(s) ${[...rn.moved.keys()].join(", ")} already used elsewhere, renumbered to ${[...rn.moved.values()].join(", ")}`);
    }
    // The Dependencies grammar, as on every other write.
    const dep = enforceDependencies(o.text as string, normalizedSourcesFor(ctx.project, ctx.task));
    o.text = dep.text;
    if (dep.reset.length) { depResets.push(`${o.section}: ${dep.reset.join(", ")}`); console.error(`[drafts] ${o.section}: Dependencies reset on ${dep.reset.join(", ")} in the fix pass`); }
    // The same guard a save through write_section gets: a section that comes back much shorter, or without its
    // citations or IDs, is not put in.
    const prev = doc.text(o.section) ?? "", t = o.text as string;
    const refusal = destructiveSave({
      kind: "section", newLen: t.length, prevLen: prev.length, name: `${artifact} § ${o.section}`,
      prevCitations: countCitations(prev), newCitations: countCitations(t), prevIds: countIds(prev), newIds: countIds(t),
    });
    if (refusal) { console.error(`[drafts] ${o.section}: fix not taken — it would shrink the section or drop its citations or IDs`); o.text = null; }
  }
  const changed = out.filter((o) => o.text && o.text !== doc.text(o.section));
  if (!changed.length) return { changed: 0, depResets };
  for (const o of changed.slice(0, -1)) doc.set(o.section, o.text!);
  const lastO = changed[changed.length - 1];
  const r = await handleWriteSection(ctx, { artifact, section: lastO.section, content: lastO.text! });
  console.error(`[drafts] findings sent back to ${byArea.size} section(s); ${changed.length} changed in ${Math.round((Date.now() - started) / 1000)}s`);
  return { changed: changed.length, saved: r.saved, depResets };
}

// The second reader (see source-review.ts). A model call that did not write the requirements reads each one
// against the sources; the server drops any finding whose quoted source wording is not in them.
const SOURCE_REVIEW = (process.env.SOURCE_REVIEW ?? "on") !== "off";
const REVIEW_MODEL = process.env.REVIEW_MODEL || "";
const REVIEW_BATCH = Number(process.env.REVIEW_BATCH ?? 8);
// Batches read side by side after the first, which goes alone so the sources are in the prompt cache.
const REVIEW_CONCURRENCY = Number(process.env.REVIEW_CONCURRENCY ?? 5);

/** The section of a document built with write_section that holds a requirement. */
function sectionOfIn(doc: SectionedDoc | undefined): (req: string) => string {
  return (req) => {
    if (!doc) return "";
    const re = new RegExp(`^#{1,6}\\s+${req.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m");
    return doc.titles().find((t) => re.test(doc.text(t) ?? "")) ?? "";
  };
}

const REVIEW_CALL_TIMEOUT_MS = Number(process.env.REVIEW_CALL_TIMEOUT_MS ?? 240_000);
const STREAM_IDLE_MS = Number(process.env.STREAM_IDLE_MS ?? 90_000);
/** Models that answered a forced tool choice with a 400, so the reviewer asks them by name. */
const NO_FORCED_TOOL = new Set<string>();
/** Models that answered a structured-output request with a 400, so the reviewer uses the tool instead. */
const NO_STRUCTURED = new Set<string>();
function makeReviewer(sources: SourceText[], onCall?: (ms: number, u: Usage) => void): AskReviewer {
  const system = [
    { type: "text", text: REVIEW_SYSTEM },
    // The same text for every batch, so the model's prompt cache holds it after the first call.
    { type: "text", text: sourcesBlock(sources), cache_control: { type: "ephemeral" } },
  ];
  return async (batch) => {
    try {
      const t0 = Date.now();
      const model = REVIEW_MODEL || MODEL;
      // First choice: a structured output. The API enforces the shape, so there is no tool to force or to skip.
      if (!NO_STRUCTURED.has(model)) {
        try {
          const resp = await anthropic.messages.create({
            model, max_tokens: 12000, system: system as any,
            output_config: { format: { type: "json_schema", schema: REVIEW_SCHEMA as any } },
            messages: [{ role: "user", content: batchPrompt(batch) }],
          } as any, { timeout: REVIEW_CALL_TIMEOUT_MS, maxRetries: 2 }) as Anthropic.Message;
          onCall?.(Date.now() - t0, usageOf(resp.usage));
          const text = resp.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { parsed = undefined; }
          // Unparseable (cut off at max_tokens, say) is an unanswered batch: reviewDocument asks again, then names it.
          return coerceReview(parsed);
        } catch (e) {
          if ((e as any)?.status !== 400) throw e;
          NO_STRUCTURED.add(model);
          console.error(`[review] ${model} does not accept structured output (${String((e as Error).message).slice(0, 120)}); using the review tool`);
        }
      }
      const call = (forced: boolean) => anthropic.messages.create({
        model,
        max_tokens: 12000,
        system: system as any,
        tools: [REVIEW_TOOL as any],
        // Newer models (Sonnet 5.5, Opus 5.5, Fable 5.1+) reject a forced tool choice with a 400; the cloud app runs
        // Sonnet 5.5 and every review call failed there until this. Ask by name instead and let the model choose.
        tool_choice: forced ? { type: "tool", name: REVIEW_TOOL.name } : { type: "auto" },
        messages: [{ role: "user", content: forced ? batchPrompt(batch) : `${batchPrompt(batch)}\n\nAnswer only by calling the ${REVIEW_TOOL.name} tool.` }],
      }, { timeout: REVIEW_CALL_TIMEOUT_MS, maxRetries: 2 }); // a batch takes 1–3 minutes; run 20's one stuck call took 18
      let resp: Anthropic.Message;
      if (NO_FORCED_TOOL.has(model)) resp = await call(false);
      else {
        try { resp = await call(true); }
        catch (e) {
          if ((e as any)?.status !== 400 || !/tool_choice/i.test(String((e as Error).message))) throw e;
          NO_FORCED_TOOL.add(model);
          console.error(`[review] ${model} does not accept a forced tool choice; asking by name instead`);
          resp = await call(false);
        }
      }
      onCall?.(Date.now() - t0, usageOf(resp.usage));
      const tu = resp.content.find((b) => b.type === "tool_use") as any;
      return coerceReview(tu?.input);
    } catch (e) {
      console.error(`[review] independent reviewer call failed: ${(e as Error).message}`);
      return [];
    }
  };
}

/** What the second reader found in a document, worded for the writer; null when there is nothing to say or it is switched off. */
async function independentReview(
  ctx: { project: Project | null; task: string; memory: ReviewMemory; emit?: (e: any) => void; perf?: RunPerf },
  content: string, sectionOf: (req: string) => string
): Promise<string | null> {
  return (await independentReviewReport(ctx, content, sectionOf)).text;
}

async function independentReviewReport(
  ctx: { project: Project | null; task: string; memory: ReviewMemory; emit?: (e: any) => void; perf?: RunPerf },
  content: string, sectionOf: (req: string) => string
): Promise<{ text: string | null; report?: ReviewReport }> {
  if (!SOURCE_REVIEW || !ctx.project) return { text: null };
  // Its own sources: the task, this project's documents, and the Golden items the document cites.
  const all = documentSources(ctx.project, ctx.task);
  const own = new Set(ownSources(all).map((s) => s.name));
  const sources = all.filter((s) => own.has(s.name) || content.includes(s.name.split(" ")[0]));
  if (sources.length < 2 || requirementBlocks(content).length < 3) return { text: null };
  ctx.emit?.({ type: "notice", message: "An independent reviewer is reading the requirements against their sources…" });
  const started = Date.now();
  const report = await reviewDocument({
    doc: content, sources, memory: ctx.memory, batchSize: REVIEW_BATCH, concurrency: REVIEW_CONCURRENCY,
    ask: makeReviewer(sources, (ms, u) => ctx.perf?.reviewCall(ms, u)),
  });
  ctx.perf?.reviewRound(Date.now() - started);
  console.error(`[review] independent reviewer: read ${report.read}/${report.total}, ${report.findings.length} with findings (${report.findings.filter((f) => f.verdict === "fail").length} failing), ${report.droppedClaims} unverifiable claim(s) dropped, ${report.missing.length} unreturned, ${Math.round((Date.now() - started) / 1000)}s`);
  // An unreturned requirement was not reviewed. Saying nothing would read as "clean" (the cloud's reviewer failed
  // every call for a day and nobody was told).
  const unreturned = report.missing.length
    ? `⚠ **Independent review incomplete — the reviewer returned no verdict for ${report.missing.length} requirement(s)** (${report.missing.slice(0, 12).join(", ")}${report.missing.length > 12 ? ", …" : ""}). They are not reviewed; say so in your answer.`
    : "";
  const text = formatReview(report, sectionOf);
  if (text) return { text: unreturned ? `${text}\n\n${unreturned}` : text, report };
  if (unreturned) return { text: unreturned, report };
  return { text: report.read ? `✓ An independent reviewer read ${report.read} requirement${report.read === 1 ? "" : "s"} against the sources and found nothing to change.` : null, report };
}

// Synthetic tool: terms the sources define differently. Handled here because it needs the
// task text, the project's input documents and its Golden selection together.
function compareSourcesTool(): Anthropic.Tool {
  return {
    name: "compare_sources",
    description:
      "Find terms that different sources define in unlike words — the task prompt, this project's input documents, and the Golden Repository items you can see. Call it after reading the sources and before writing. It returns candidates for you to judge: record each genuine disagreement as a 'Source Conflict Identified' with both wordings quoted, and do not choose between them.",
    input_schema: { type: "object", properties: {} } as Anthropic.Tool.InputSchema,
  };
}

/** Everything a document-sourced deliverable may draw on: the task, this project's input documents, and the Golden items it can see. */
/** What the project asked for but the run cannot use (see degradedSources). */
function sourceDegradation(project: Project | null, task: string): string[] {
  const inputs = project
    ? walkFiles(inputsDirOf(project), project.artifactsDir).map((f) => {
        try { return { path: f.path, text: fs.readFileSync(path.join(project.artifactsDir, f.path), "utf8") as string | null }; }
        catch { return { path: f.path, text: null }; }
      })
    : [];
  const visible = golden.selectedFor(project?.golden, project?.id);
  const explicit = project?.golden?.mode === "subset" ? project.golden.itemIds ?? [] : [];
  // Explicitly selected items count even when archived, so "selected but archived" is said rather than hidden.
  const selected = [...visible, ...explicit.map((id) => golden.get(id)).filter((i): i is NonNullable<typeof i> => !!i && !visible.includes(i))]
    .map((i) => ({ id: i.id, title: i.title, status: i.status, content: golden.readContent(i.id) }));
  return degradedSources({ inputs, selected, selectedIds: explicit, task });
}

function documentSources(project: Project | null, task: string): { name: string; text: string }[] {
  const sources: { name: string; text: string }[] = [{ name: "task prompt", text: task }];
  if (project) {
    for (const f of walkFiles(inputsDirOf(project), project.artifactsDir)) {
      try { sources.push({ name: f.path, text: fs.readFileSync(path.join(project.artifactsDir, f.path), "utf8") }); } catch { /* unreadable: skipped */ }
    }
  }
  for (const i of golden.selectedFor(project?.golden, project?.id).filter((x) => x.status === "published")) {
    const text = golden.readContent(i.id);
    if (text) sources.push({ name: `${i.id} (${i.title})`, text });
  }
  return sources;
}

function handleCompareSources(
  project: Project | null, task: string, agentId: string, runId: string, commit: string
): { text: string; conflicts: TermConflict[] } {
  const sources = documentSources(project, task);
  // Only disagreements involving the task or this project's own documents matter to the
  // document being written; reference items disagreeing among themselves do not.
  const own = new Set(ownSources(sources).map((s) => s.name));
  const conflicts = termConflicts(sources, 0.4, (name) => own.has(name));
  const text = `Compared ${sources.length} sources (${sources.map((s) => s.name).slice(0, 6).join("; ")}${sources.length > 6 ? "; …" : ""}).\n\n${formatConflicts(conflicts)}`;
  evidence.addObservation({
    runId, projectId: project?.id ?? "", agent: agentId, tool: "compare_sources",
    args: `sources=${sources.length}`, outputHash: sha256(text), excerpt: text.slice(0, 300), commit, files: [],
  });
  return { text, conflicts };
}

// ---------------------------------------------------------------------------
// Agentic loop — Claude picks tools, MCP executes, events stream to the UI
// ---------------------------------------------------------------------------
let anthropic = new Anthropic({ maxRetries: 4 }); // reads ANTHROPIC_API_KEY

/** The deploy-time key, remembered so clearing the in-app override can fall back to it. */
const envApiKey = process.env.ANTHROPIC_API_KEY ?? "";

// Update the key/model at runtime (from the in-app Settings panel) and best-effort
// persist to ui/.env so it survives a restart.
/**
 * Settings changed in the app, kept where they survive.
 *
 * These used to be written to `ui/.env`. On a developer's machine that persists; in
 * the container it is `/app/ui/.env`, which is part of the image and gone on the next
 * restart — so a key changed through the Settings panel worked until Azure recycled
 * the container and then silently reverted to the older App Service setting. The panel
 * looked identical in both places and only told the truth in one.
 *
 * STATE_DIR is the directory that is already mapped to durable storage, which is why
 * projects, threads and the Golden Repository live there.
 */
const SETTINGS_FILE = path.join(STATE_DIR, "settings.json");

/** Where the key in force actually came from — surfaced so it is never a guess. */
let keySource: "in-app" | "environment" | "none" =
  process.env.ANTHROPIC_API_KEY ? "environment" : "none";

function applySettings({ apiKey, model }: { apiKey?: string; model?: string }) {
  if (typeof apiKey === "string") {
    const k = apiKey.trim();
    if (k) {
      process.env.ANTHROPIC_API_KEY = k;
      anthropic = new Anthropic({ apiKey: k, maxRetries: 4 });
      keySource = "in-app";
    } else {
      // Cleared on purpose: drop the stored override and fall back to whatever the
      // environment supplies, so rotating the App Service setting can take effect.
      delete process.env.ANTHROPIC_API_KEY;
      if (envApiKey) process.env.ANTHROPIC_API_KEY = envApiKey;
      anthropic = new Anthropic({ maxRetries: 4 });
      keySource = envApiKey ? "environment" : "none";
    }
  }
  if (typeof model === "string" && model.trim()) {
    MODEL = model.trim();
    process.env.MODEL = MODEL;
  }
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const stored: Record<string, string> = { model: MODEL };
    if (keySource === "in-app" && process.env.ANTHROPIC_API_KEY) {
      stored.apiKey = process.env.ANTHROPIC_API_KEY;
    }
    const tmp = `${SETTINGS_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (e) {
    console.error("[settings] could not persist settings.json:", (e as Error).message);
  }
}

/**
 * Restore settings saved in the app.
 *
 * An in-app key wins over the environment, because someone typing it into the panel
 * is making a deliberate, later choice than whatever was configured at deploy time —
 * and if it did not win, the panel would not really do anything in the cloud. Clearing
 * the field removes the override, which is the way back to the environment value.
 */
function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    if (typeof raw.model === "string" && raw.model.trim()) {
      MODEL = raw.model.trim();
      process.env.MODEL = MODEL;
    }
    if (typeof raw.apiKey === "string" && raw.apiKey.trim()) {
      process.env.ANTHROPIC_API_KEY = raw.apiKey.trim();
      anthropic = new Anthropic({ apiKey: raw.apiKey.trim(), maxRetries: 4 });
      keySource = "in-app";
      console.error("[settings] using the API key set in the app (clear it in Settings to fall back to the environment)");
    }
  } catch { /* no saved settings — the environment stands */ }
}

// Deep agents (threat model, code-gen, orchestrator) need many tool-call turns
// before they synthesise. Too low a cap truncates them mid-analysis. Configurable.
const MAX_TURNS = Number(process.env.MAX_TURNS_PER_RUN ?? 44);
/** How many times a finished document that still fails its checks is handed back to the agent. */
const MAX_REVIEW_ROUNDS = Number(process.env.REVIEW_ROUNDS ?? 2);

// ---------------------------------------------------------------------------
// Diagnostics — recent operational history, in memory.
//
// "Why was that slow?" and "why did that run stop early?" were only answerable by
// reading the container log, which on App Service means a separate token audience, a
// Kudu endpoint, or a portal blade. That is too much friction for a question that
// comes up constantly, so the numbers the log already prints are kept here too.
//
// Bounded, and deliberately free of anything sensitive: no prompts, no answers, no
// keys — timings, counts, and which project.
// ---------------------------------------------------------------------------
const DIAG_KEEP = 50;
const diagnostics: Record<"uploads" | "workspaces" | "runs", any[]> = {
  uploads: [], workspaces: [], runs: [],
};

function recordDiag(kind: keyof typeof diagnostics, row: Record<string, unknown>) {
  const list = diagnostics[kind];
  list.push({ at: new Date().toISOString(), ...row });
  if (list.length > DIAG_KEEP) list.splice(0, list.length - DIAG_KEEP);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- prompt caching over the conversation ---------------------------------
// The API allows 4 cache breakpoints per request; the system block takes one.
const MSG_BREAKPOINTS = 3;
// Each breakpoint searches back at most 20 content blocks for an existing cache
// entry. A single turn here can add far more than that (57 tool calls observed),
// so consecutive breakpoints must stay inside that window or the newest one
// silently finds nothing and the whole conversation is re-billed.
const LOOKBACK_GAP = 15;

/** Block types that accept cache_control. */
const CACHEABLE = new Set(["text", "tool_use", "tool_result", "image", "document"]);

const LOG_CACHE = process.env.LOG_CACHE === "1";
/** Cumulative since boot; exposed on /api/health so hit rate is checkable in prod. */
const cacheStats = { read: 0, written: 0, uncached: 0 };

const blocksOf = (m: Anthropic.MessageParam) =>
  typeof m.content === "string" ? 1 : m.content.length;

/**
 * Return a copy of the conversation with rolling cache breakpoints, so each turn
 * reuses the previous turn's cached prefix instead of re-sending it at full price.
 *
 * Copies rather than mutates: `messages` is reused across turns of a run, and
 * leaving markers behind would accumulate stale breakpoints past the limit of 4.
 */
function withConversationCache(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (!msgs.length) return msgs;

  const mark = new Set<number>();
  let since = 0;
  for (let i = msgs.length - 1; i >= 0 && mark.size < MSG_BREAKPOINTS; i--) {
    if (mark.size === 0) { mark.add(i); since = 0; continue; }  // newest turn always
    since += blocksOf(msgs[i]);
    if (since >= LOOKBACK_GAP) { mark.add(i); since = 0; }
  }

  return msgs.map((m, i) => {
    if (!mark.has(i)) return m;
    const blocks = (typeof m.content === "string"
      ? [{ type: "text", text: m.content } as Anthropic.TextBlockParam]
      : [...m.content]) as any[];
    // Anchor on the last block the API will accept a marker on.
    const at = blocks.map((b) => CACHEABLE.has(b?.type)).lastIndexOf(true);
    if (at < 0) return m;
    blocks[at] = { ...blocks[at], cache_control: { type: "ephemeral" } };
    return { ...m, content: blocks } as Anthropic.MessageParam;
  });
}

// The code index and tools are multi-language (C#, Java, TypeScript/JS incl.
// Angular & React). Agent personas were originally written for .NET, so this
// shared note tells every agent to adapt to whatever stack the active project
// actually is. For a .NET project the guidance below is a no-op — the stack IS
// C#/.NET — so this doesn't change existing .NET behaviour.
const STACK_AWARENESS = `
---
## Work in the project's actual stack

This platform symbol-indexes twelve languages: C# (Roslyn), Java, TypeScript/JavaScript (including
Angular and React), Python, Go, PHP, Ruby, Rust, Scala, C, C++, and Shell. Every other file is still
searchable, just not symbol-indexed — \`find_symbol\`/\`find_references\` won't resolve it, so lean on
\`search_code\` there. Before applying any language- or framework-specific convention:

- **Detect the stack from the real files** — file extensions and the manifests
  (\`*.csproj\`/\`*.sln\`, \`pom.xml\`/\`build.gradle\`, \`package.json\`/\`angular.json\`/\`tsconfig.json\`,
  \`go.mod\`, \`Cargo.toml\`, \`pyproject.toml\`/\`requirements.txt\`, \`Gemfile\`, \`composer.json\`,
  \`build.sbt\`, \`CMakeLists.txt\`). Use \`solution_overview\` and \`search_code\` to confirm; don't assume
  .NET/C# just because a persona's examples do.
- **Use the conventions that project actually uses** — its language and version, build tool
  (MSBuild / Maven / Gradle / npm / pnpm / pip / Cargo / go build), test framework (xUnit/NUnit/MSTest,
  JUnit, Jest/Vitest, Cypress/Playwright, pytest, go test), DI style, and folder layout. Examples in a
  persona that name .NET/nopCommerce specifics are illustrative — translate them to the stack in front
  of you.
- **Name idioms correctly per stack** — e.g. Spring \`@Service\`/\`@RestController\`/JPA repositories for
  Java; components/services/modules/RxJS for Angular; components/hooks/props for React; package-level
  functions and interfaces for Go; modules and traits for Rust.
- If the codebase is **polyglot** (e.g. a Java/Spring API with an Angular or React front end), be
  explicit about which part you're analysing and watch the boundary between them.`;

// Shared operating discipline appended to EVERY agent's system prompt. It encodes the
// "Required Operating Controls" from the black-box test report (2026-07-24): the four
// failed cases and most conditional passes came from the same handful of habits —
// continuing without a required input, stating inference as fact, claiming unrun
// build/test/deploy success, echoing secret values, inflating severity, and treating a
// recommendation as an approval. This is a per-run guardrail, not a guarantee; agent
// output is probabilistic and still needs human review.
const OPERATING_CONTRACT = `
---
## Operating discipline (applies to every response — overrides any looser instruction above)

1. **Missing prerequisite → stop, don't invent.** If the task needs an input you cannot
   actually see through your tools — a change set / diff, an approved artifact, a git
   history, a named brief, a real consumer or call site — do not reconstruct or assume it.
   Return a clear **BLOCKED** result naming exactly what is missing and how to supply it.
   Proving a target is genuinely absent (evidence-based **Not Applicable**) is a correct,
   complete answer — never fabricate content to fill a gap.

2. **Separate what you saw from what you infer.** Label claims so a reviewer can tell them
   apart: **Observed** (read directly in code/config, cite \`file.cs:line\`), **Inferred**
   (reasoned from evidence), **Assumption**, **Open question**, **Unverified**. Never present
   inference — a possible consumer, a default's effect, a runtime behaviour, a deployment
   path — as an established fact.

3. **No unverified success claims.** Do not state that anything built, compiled, tested,
   restored, packaged, deployed, or that an alert fired, unless you actually ran the command
   through a tool and captured the output. If you did not run it, say so and mark it
   **Unverified**.

   Every tool you have is **static** — it reads files, searches text, walks git history and
   runs a linter. None of them start the application, reach a deployed environment, compile
   anything, or run a test. So you are never in a position to write these:

   | Don't write | Write instead |
   |---|---|
   | "Authentication is disabled in production." | "\`Auth__Enabled=false\` in \`appsettings.json:12\` (**Observed**). If this file is the one deployed, authentication would be off (**Inferred** — deployment config not visible here)." |
   | "This endpoint is actively exploited." | "This route has no authorization attribute (**Observed**, \`Foo.cs:44\`). Exploitable only if it is reachable unauthenticated in a deployed environment (**Unverified**)." |
   | "All 14 tests pass." | "14 test methods exist (**Observed**). Nothing was executed in this run, so pass/fail is **Unverified**." |
   | "Coverage is 78%." | "\`coverlet.collector\` is absent from the test project (**Observed**), so no coverage figure can be produced here." |

   **This is checked after every run.** Sentences asserting live behaviour, active
   compromise, or build/test results without a qualifier are detected and flagged beneath
   your answer. The flag is factual and you cannot argue with it — so write the qualified
   version the first time.

4. **Never reproduce secrets.** If you encounter credential-like values (keys, tokens,
   connection strings, passwords), refer to them by key/location only — never echo the value.

5. **Severity must be earned.** Assign High/Critical only when you can point to a real caller
   and a concrete impact. Otherwise down-rank and mark the impact **Unverified**. Do not
   inflate severity for emphasis.

6. **You propose; a human approves.** Your recommendation is never an approval, a merge, or a
   sign-off. Keep proposals distinct from applied changes, and never imply autonomy to rotate
   secrets, rewrite git history, edit live configuration, publish packages, or execute a
   rollback. A material change to an already-produced artifact voids any prior approval and
   must be re-reviewed.

7. **Report state honestly.** Distinguish response text from a saved artifact from a proposed
   patch from an applied change. If you cut a corner, ran out of turns, or skipped a step,
   say so plainly rather than implying completeness.

8. **"Compatible" is not one question.** These fail independently, and a reader acts on your
   verdict — so say which one you checked, and which you did not:

   | Kind | Breaks when | Cheap tell |
   |---|---|---|
   | **Source** | callers no longer compile | signature, generic arity, optional params |
   | **Binary** | *compiled* callers break though source is fine | reordered/added params, type→interface, const→static readonly, renamed public member |
   | **Schema** | stored data no longer loads | column type/nullability, added NOT NULL, dropped default |
   | **Serialization** | payloads or documents no longer round-trip | renamed DTO property, changed enum numbering, tightened contract |
   | **Package** | resolution or transitive graph breaks | major bump, changed TFM, moved namespace |
   | **Migration** | the upgrade path itself fails | irreversible step, no rollback, ordering dependency |

   Source compatibility is the weakest of these and the easiest to mistake for the others: a
   method whose signature is unchanged in source can still break every compiled caller, and a
   renamed DTO property breaks nothing at compile time and every persisted document at read
   time. **Never write "backward compatible", "non-breaking", "purely additive" or "safe to
   remove" unqualified** — an unqualified verdict is flagged automatically beneath your answer.

   For a removal, "safe" also means unreachable by the routes that have no visible call site:
   reflection, DI registration, configuration binding, serialization, and entry points. If you
   did not check those, say which you did not.

9. **Evidence comes from the server, not from you.** A tool result that ends with
   \`[evidence EV-XXXXXXXX]\` has been recorded in a ledger you cannot write to. When you reach a
   conclusion a reviewer should be able to check, call \`record_claim\` with the statement, what
   observation would prove it false, and the evidence IDs it rests on. A claim with no evidence
   is recorded as **unsupported**, and evidence goes **stale** when the files it was taken
   against change. Cite IDs exactly as given — an ID that does not exist in this project's
   ledger is flagged beneath your answer. Evidence here means "a static tool returned this",
   never "this was run".`;


// Transient API failures worth retrying (connection drops, overload, 5xx).
function isRetryable(e: any): boolean {
  if (e instanceof Anthropic.APIConnectionError) return true;
  const s = e?.status;
  if (s === 408 || s === 409 || s === 429 || s === 500 || s === 503 || s === 529) return true;
  const m = String(e?.message ?? "").toLowerCase();
  return m.includes("terminated") || m.includes("connection") || m.includes("overloaded");
}

/**
 * The slice of the Golden Repository this agent should be aware of: the active
 * project's selection, narrowed by each item's `appliesTo`. Returns "" when nothing
 * applies, so agents and projects without golden content are completely unaffected.
 */
function goldenCatalogFor(agentId: string, project: Project | null): string {
  try {
    const selected = golden.selectedFor(project?.golden, project?.id);
    return catalogBlock(
      GoldenStore.relevantTo(selected, agentId),
      CATALOG_CAP,
      boundTemplates(agentId, project).map((t) => t.id)
    );
  } catch (e) {
    console.error("[golden] catalog build failed:", (e as Error).message);
    return "";
  }
}

const ORCH_ID = "orchestrator";
// Read-only grounding tools the Orchestrator may use directly (besides `delegate`).
const ORCH_GROUNDING = ["solution_overview", "find_symbol", "search_code", "read_file", "list_artifacts", "read_artifact", "save_artifact"];

/**
 * The Golden Repository is a universal grounding layer, so EVERY agent gets these —
 * independently of the `tools:` list in its persona. Without this an agent sees the
 * catalog in its system prompt but has no way to read what it names, which (correctly)
 * makes it return BLOCKED instead of answering.
 */
const GOLDEN_TOOLS = ["golden_catalog", "golden_search", "golden_read"];
/** What an agent needs to answer "what did this branch change?". */
const SCOPE_TOOLS = ["git_diff", "git_log", "git_show", "git_status"];

/**
 * Reading a previous stage's output is not a privilege — it is the handoff.
 *
 * Every one of the 32 personas declares `save_artifact`; only three declared
 * `read_artifact`. So 29 agents could write a deliverable and none of them could open
 * one, which makes a chain impossible by construction. Round 2 scored the consequences
 * without naming the cause: Regression got 5 for assessing "candidate artifacts [that]
 * could not be read" — it had no tool that could read them; Code Generation identified
 * a missing ADR it could not have opened; ADR continued past a BRD it could not
 * retrieve.
 *
 * Read-only and confined to the active project's own artifacts directory, so granting
 * it universally costs nothing and removes the floor under those failures.
 */
const ARTIFACT_READ_TOOLS = ["list_artifacts", "read_artifact"];

/**
 * Templates bound to a specific agent: published `template` items whose appliesTo
 * names THIS agent explicitly. "all" is deliberately excluded — a template that
 * applies to everything is guidance, not a binding contract for one deliverable.
 */
function boundTemplates(agentId: string, project: Project | null) {
  return golden
    .selectedFor(project?.golden, project?.id)
    .filter((i) => i.kind === "template" && i.status === "published" && i.appliesTo.includes(agentId));
}

/**
 * Phase 3 enforcement. Returns an error string to hand back instead of running the
 * tool, or null to allow it. We gate the act of *delivering* (save_artifact), not
 * thinking — the agent may explore freely, but it cannot produce the deliverable
 * until it has actually read the template that governs it.
 */
function templateGate(agentId: string, toolName: string, readSoFar: Set<string>, project: Project | null): string | null {
  if (toolName !== "save_artifact" && toolName !== "write_section") return null;
  const missing = boundTemplates(agentId, project).filter((t) => !readSoFar.has(t.id.toUpperCase()));
  if (missing.length === 0) return null;

  const list = missing.map((t) => `\`${t.id}\` (${t.title})`).join(", ");
  return (
    `BLOCKED — the artifact was NOT saved.\n\n` +
    `Your organisation binds ${missing.length === 1 ? "a template" : "templates"} to this deliverable: ${list}.\n` +
    `Call \`golden_read\` on ${missing.length === 1 ? "it" : "each of them"} first, follow the structure, ` +
    `then call save_artifact again and cite the template as \`id@version\`.\n\n` +
    `This is a platform rule, not a suggestion — producing the deliverable in a different ` +
    `shape than the organisation's template is the failure it exists to prevent.`
  );
}

// Synthetic tool that lets the Orchestrator run another agent and get its result.
function delegateTool(): Anthropic.Tool {
  const ids = agents.filter((a) => a.id !== ORCH_ID).map((a) => a.id);
  return {
    name: "delegate",
    description:
      "Delegate a sub-task to another SDLC agent and receive its result. Use this to execute your plan step by step.",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ids, description: "Which specialist agent to run." },
        task: { type: "string", description: "A precise, self-contained instruction for that agent (it has no other context)." },
      },
      required: ["agent", "task"],
    } as Anthropic.Tool.InputSchema,
  };
}

// Synthetic tool: lets an agent put a conclusion on the record, tied to the evidence
// it rests on. Handled here rather than in the MCP server because the ledger lives
// here — and because the agent must not be able to write the evidence side of it.
function recordClaimTool(): Anthropic.Tool {
  return {
    name: "record_claim",
    description:
      "Record a conclusion a reviewer should be able to check. Give the statement, what observation would prove it false, and the evidence IDs (EV-XXXXXXXX, shown at the end of tool results) it rests on. A claim with no evidence is recorded as unsupported; evidence goes stale when the files it was taken against change. You cannot create evidence — only cite what tools returned.",
    input_schema: {
      type: "object",
      properties: {
        statement: { type: "string", description: "The claim, one checkable sentence." },
        disproof: { type: "string", description: "What observation would show the statement is false." },
        risk: { type: "string", enum: ["low", "medium", "high"], description: "Cost of being wrong." },
        evidence: { type: "array", items: { type: "string" }, description: "Evidence IDs this rests on." },
      },
      required: ["statement", "disproof"],
    } as Anthropic.Tool.InputSchema,
  };
}

function handleRecordClaim(
  project: Project | null, agentId: string, runId: string, input: Record<string, unknown>
): { text: string; isError: boolean } {
  const statement = String(input.statement ?? "").trim();
  const disproof = String(input.disproof ?? "").trim();
  if (!statement || !disproof)
    return { isError: true, text: "Refused: a claim needs both a statement and what observation would prove it false." };

  const projectId = project?.id ?? "";
  const risk: Risk = input.risk === "high" || input.risk === "medium" ? input.risk : "low";
  const cited = Array.isArray(input.evidence) ? input.evidence.map((e) => String(e).trim().toUpperCase()) : [];
  const unknown = cited.filter((id) => !evidence.getEvidence(id, projectId));
  if (unknown.length)
    return {
      isError: true,
      text:
        `Refused: ${unknown.join(", ")} ${unknown.length > 1 ? "do" : "does"} not exist in this project's evidence ledger. ` +
        `Cite only the IDs shown at the end of tool results (\`[evidence EV-XXXXXXXX]\`) — you cannot create evidence, only reference it.`,
    };

  const claim = evidence.addClaim({ runId, projectId, agent: agentId, statement, disproof, risk, evidence: cited });
  const fresh = new Map<string, Freshness>(
    cited.map((id) => [id, freshnessOf(evidence.getEvidence(id, projectId)!, project?.sourceRoot ?? "")])
  );
  const status = claimStatus(claim, fresh);
  const lines = cited.map((id) => `- ${id}: ${fresh.get(id)}`);
  const unscoped = [...fresh.values()].filter((f) => f === "unscoped").length;
  return {
    isError: false,
    text:
      `Recorded claim ${claim.id} (risk ${risk}) — **${status}**.\n` +
      (lines.length ? lines.join("\n") + "\n" : "No evidence cited, so this claim is unsupported.\n") +
      (unscoped ? `${unscoped} cited record${unscoped > 1 ? "s are" : " is"} unscoped (no file list), so staleness cannot be detected for ${unscoped > 1 ? "them" : "it"}.\n` : "") +
      `Note: evidence is a static tool's observation — nothing was executed.`,
  };
}

async function runAgent(
  run: RunContext,
  agent: Agent,
  userMessage: string,
  emit: (e: any) => void,
  depth = 0,
  prior: Anthropic.MessageParam[] = []
): Promise<string> {
  const { project, ws } = run;
  const mcpTools = ws.tools;
  // Time and tokens, recorded as they happen (see perf.ts). A tool's time is from the start of its turn's tool loop
  // to its result, which is when it is emitted; a delegate's nested events carry delegateId and are timed by their own run.
  const perf = new RunPerf();
  let toolT0 = Date.now();
  const rawEmit = emit;
  emit = (e: any) => {
    if (e?.type === "tool_result" && !e.delegateId) {
      const ms = Date.now() - toolT0;
      perf.tool(String(e.name), ms);
      rawEmit({ type: "tool_time", id: e.id, name: e.name, ms });
    }
    rawEmit(e);
  };
  let outText = ""; // this agent's own streamed answer (returned so it can be persisted)
  // Golden items this run has actually read — the evidence the template gate checks.
  const goldenReadThisRun = new Set<string>();
  // Inputs this run named and could not retrieve, and what it actually wrote — the
  // evidence behind the prerequisite gate and the saved-claim check.
  const failedArtifactReads = new Set<string>();
  // Files this task names as inputs, and the ones actually opened — by either tool,
  // since a named prerequisite may be a source file rather than a prior deliverable.
  const required = requiredInputs(userMessage);
  const readOk = new Set<string>();
  const savedThisRun = new Set<string>();
  const proposedThisRun = new Set<string>();
  // Orchestrator (top level only) gets read-only grounding tools + `delegate`.
  // Everyone else: intersect declared tools with what the MCP server provides.
  const isOrch = agent.id === ORCH_ID && depth === 0;
  let tools: Anthropic.Tool[];
  if (isOrch) {
    tools = [...mcpTools.filter((t) => ORCH_GROUNDING.includes(t.name)), delegateTool()];
  } else {
    const allowed = mcpTools.filter((t) => agent.tools.includes(t.name));
    tools = allowed.length ? allowed : mcpTools;
  }
  // Always grant the Golden Repository tools — see GOLDEN_TOOLS — and the ability to
  // read prior artifacts — see ARTIFACT_READ_TOOLS.
  const alwaysOn = [...GOLDEN_TOOLS, ...ARTIFACT_READ_TOOLS];
  const missingAlwaysOn = mcpTools.filter(
    (t) => alwaysOn.includes(t.name) && !tools.some((x) => x.name === t.name)
  );
  if (missingAlwaysOn.length) tools = [...tools, ...missingAlwaysOn];
  tools = [...tools, recordClaimTool()];
  // Agents that write from source documents declare compare_sources; they also get the
  // stricter rules below (every input document read, citations checked against the text).
  const isDocAgent = agent.tools.includes("compare_sources");
  if (isDocAgent) tools = [...tools, compareSourcesTool(), writeSectionTool(), patchSectionTool(), checkDocumentTool(), draftRequirementsTool(), draftChaptersTool()];
  let conflictsFound: TermConflict[] = [];
  const sectionDocs = new Map<string, SectionedDoc>();
  const sectionPaths = new Map<string, string>();
  let reviewRounds = 0;
  /** Which requirements the independent reviewer has read, so a requirement is read again only when it changes. */
  const reviewMemory = new ReviewMemory();
  /** Saves refused once as destructive; the same content sent again is allowed. */
  const refusedSaves = new Set<string>();
  let lastDocSaved: { name: string; content: string } | null = null;
  /** Requirement areas and chapters being written in parallel (draft_requirements, draft_chapters). */
  const draftJobs: DraftJob[] = [];
  const draftRefused = new Set<string>();
  /** Whether check_document has sent the reviewer's findings back to the area writers yet (once a run). */
  let areasRefixed = false;
  /** check_document calls so far (limited in a drafted run, see DRAFTED_CHECK_LIMIT). */
  let checksDone = 0;
  const pendingJob = () => draftJobs.find((j) => !j.reported);
  /** Wait for everything still being drafted, take the document as it was left, and say what came of it (once each). */
  const settleDrafts = async (): Promise<string> => {
    const out: string[] = [];
    for (const job of draftJobs.filter((j) => !j.reported)) {
      job.reported = true;
      try {
        const r = await job.promise;
        const d = sectionDocs.get(job.artifact);
        if (r.saved) savedThisRun.add(r.saved.path);
        if (d && r.saved) lastDocSaved = { name: job.artifact, content: d.compose() };
        out.push(r.summary);
      } catch (e) {
        out.push(`⚠ Parallel drafting (${job.kind}) failed: ${(e as Error).message}. Write the missing sections with write_section.`);
      }
    }
    return out.join("\n\n");
  };
  // Captured now: the identity global is replaced by the next run that starts.
  const runId = currentRun?.runId ?? "";
  const commit = currentRun?.commit ?? "";

  // A scoped run is an instruction to diff a range, so grant the tools that do it
  // whatever the agent declared. Telling an agent to call git_diff and then not
  // handing it over turns the review into a refusal — observed, not theorised.
  const scoped = reviewScopeBlock(project) !== "";
  if (scoped) {
    const missingGit = mcpTools.filter(
      (t) => SCOPE_TOOLS.includes(t.name) && !tools.some((x) => x.name === t.name)
    );
    if (missingGit.length) tools = [...tools, ...missingGit];
  }

  // Prior turns give the conversation memory; the new question goes last.
  const messages: Anthropic.MessageParam[] = [
    ...prior,
    { role: "user", content: userMessage },
  ];

  let lastStop: Anthropic.Message["stop_reason"] = null;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Stream the assistant turn so text arrives token-by-token in the UI.
    // Retry transient API errors (incl. mid-stream connection drops — "terminated").
    // tool_use blocks are only emitted AFTER finalMessage() succeeds, so a failed
    // attempt can only have produced partial *text* — we tell the client to discard
    // that partial block ("text_reset") before re-streaming, so nothing duplicates.
    let resp: Anthropic.Message | undefined;
    const turnT0 = Date.now();
    for (let attempt = 0; ; attempt++) {
      let emittedThisAttempt = 0;
      let attemptText = "";
      let idleAborted = false;
      let idleTimer: ReturnType<typeof setInterval> | undefined;
      try {
        const stream = anthropic.messages.stream({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          // Caching is a prefix match and the render order is tools -> system ->
          // messages, so this single breakpoint on the system block caches the
          // whole tool schema set with it. Both are identical on every turn of a
          // run, and a run makes one request per tool call — 57 on the heaviest
          // agent observed — so without this the same prefix is re-billed at full
          // price 57 times. The interpolated date is YYYY-MM-DD, stable for the
          // day, so it does not invalidate the prefix.
          system: [
            {
              type: "text",
              // The scope block goes last: it changes only when the user switches
              // branches, so the expensive prefix above it stays cacheable.
              text: `${agent.systemPrompt}\n\n---\n**Today's date is ${new Date().toISOString().slice(0, 10)}.** Use it for any date you write (document dates, changelogs, gate records). Never invent or guess a date.\n${STACK_AWARENESS}\n${goldenCatalogFor(agent.id, project)}\n${OPERATING_CONTRACT}${reviewScopeBlock(project)}`,
              cache_control: { type: "ephemeral" },
            },
          ],
          tools,
          messages: withConversationCache(messages),
        });
        stream.on("text", (delta) => {
          emittedThisAttempt++;
          attemptText += delta;
          emit({ type: "text_delta", text: delta });
        });
        // A connection that goes quiet is not an error the SDK notices: run 20 lost 38 minutes on one turn to
        // retries that each waited out the 10-minute default. A live stream sends something every few seconds
        // (tool input arrives as events too), so silence for STREAM_IDLE_MS means it is dead; cut it and retry.
        let lastEvent = Date.now();
        stream.on("streamEvent", () => { lastEvent = Date.now(); });
        idleTimer = setInterval(() => {
          if (Date.now() - lastEvent > STREAM_IDLE_MS) { idleAborted = true; stream.abort(); }
        }, 5000);
        resp = await stream.finalMessage();
        outText += attemptText; // commit only once the turn actually succeeded
        break;
      } catch (e) {
        if (idleAborted) (e as Error).message = `no data from the model for ${STREAM_IDLE_MS / 1000}s; connection dropped`;
        if (attempt < 3 && (idleAborted || isRetryable(e))) {
          console.error(`[agent] transient error, retry ${attempt + 1}:`, (e as Error).message);
          if (emittedThisAttempt > 0) emit({ type: "text_reset" });
          emit({ type: "notice", message: "Reconnecting to the model…" });
          await sleep(600 * (attempt + 1));
          continue;
        }
        throw e;
      } finally {
        if (idleTimer) clearInterval(idleTimer);
      }
    }
    if (!resp) break;
    lastStop = resp.stop_reason;
    {
      const ms = Date.now() - turnT0, tu = usageOf(resp.usage);
      perf.turn(ms, tu);
      emit({ type: "turn", n: turn + 1, ms, ...tu, stop: resp.stop_reason, tools: resp.content.filter((b) => b.type === "tool_use").map((b: any) => b.name) });
    }

    // Cache hit rate is invisible unless measured — a silent invalidator looks
    // exactly like working code. Zero reads across turns means it isn't working.
    const u: any = resp.usage ?? {};
    cacheStats.read += u.cache_read_input_tokens ?? 0;
    cacheStats.written += u.cache_creation_input_tokens ?? 0;
    cacheStats.uncached += u.input_tokens ?? 0;
    if (LOG_CACHE)
      console.error(
        `[cache] ${agent.id} turn ${turn + 1}: read=${u.cache_read_input_tokens ?? 0} ` +
        `write=${u.cache_creation_input_tokens ?? 0} uncached=${u.input_tokens ?? 0}`
      );

    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    // Announce tool calls for this turn (the model may request several in parallel).
    // `delegate` is shown as a nested delegation card, not a generic tool chip.
    for (const tu of toolUses) {
      if (tu.name === "delegate") continue;
      emit({ type: "tool_call", id: tu.id, name: tu.name, input: tu.input });
    }

    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason === "max_tokens") {
      emit({
        type: "error",
        message:
          `The answer was cut off at the ${MAX_TOKENS.toLocaleString()}-token output limit — what you see above is incomplete. ` +
          `Ask for one section at a time, or raise MAX_TOKENS on the server (the model supports up to 128,000).`,
      });
      break;
    }
    if (resp.stop_reason !== "tool_use") {
      // The agent is about to finish. A document-writing agent was asked to run check_document
      // and fix what it reports; in a live run it never did, and finished with invented roles
      // the per-section feedback had already named. Run the whole-document checks for it and,
      // if anything is open, hand them back once or twice before the answer stands.
      // Areas still being drafted, or drafted and never shown to the writer: wait, show them, and let it check the whole.
      if (pendingJob()) {
        emit({ type: "notice", message: "Waiting for the sections being drafted…" });
        const summary = await settleDrafts();
        messages.push({
          role: "user",
          content: [{ type: "text", text: `What you started with draft_requirements / draft_chapters is now in the document.\n\n${summary}\n\nCall check_document, fix what it reports, then give your final answer.` }],
        });
        continue;
      }
      console.error(`[review] ${agent.id}: turn ended (stop=${resp.stop_reason}) doc=${isDocAgent} saved=${lastDocSaved ? (lastDocSaved as any).name : "none"} rounds=${reviewRounds}/${MAX_REVIEW_ROUNDS}`);
      // A drafted document has had its sections' own review rounds and check_document's; one more here is enough.
      if (isDocAgent && lastDocSaved && reviewRounds < (draftJobs.length ? (checksDone >= DRAFTED_CHECK_LIMIT ? 0 : 1) : MAX_REVIEW_ROUNDS)) {
        const open = documentChecks(lastDocSaved.content, userMessage, agent.id, project, conflictsFound, true);
        // A writer who never called check_document still gets the second reader, once, on what changed.
        const second = await independentReview({ project, task: userMessage, memory: reviewMemory, emit, perf }, lastDocSaved.content, sectionOfIn(sectionDocs.get(lastDocSaved.name)));
        if (second) open.push(second);
        console.error(`[review] ${agent.id}: ${open.length} whole-document check(s) open`);
        if (open.length) {
          reviewRounds++;
          emit({ type: "notice", message: `Checking the finished document against its sources (review ${reviewRounds} of ${MAX_REVIEW_ROUNDS})…` });
          messages.push({
            role: "user",
            content: [{
              type: "text",
              text:
                `Before this is final, the server ran its whole-document checks on \`${lastDocSaved.name}\` and found:\n\n${open.join("\n\n")}\n\n` +
                `Fix what you can with patch_section, or by rewriting the sections concerned with write_section (or save_artifact for a document written in one piece), ` +
                `then give your final answer. If something cannot be fixed from the sources, say so plainly in the answer.`,
            }],
          });
          continue;
        }
      }
      break;
    }

    // Execute tools / delegations and stream results back as each completes.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      toolT0 = Date.now();
      let resultText: string;
      if (tu.name === "delegate") {
        const subId = String((tu.input as any)?.agent || "");
        const task = String((tu.input as any)?.task || "");
        const sub = agents.find((a) => a.id === subId && a.id !== ORCH_ID);
        if (!sub) {
          resultText = `ERROR: unknown agent '${subId}'`;
        } else {
          emit({ type: "delegate_start", id: tu.id, agentId: sub.id, agentName: sub.name, task });
          const captured: string[] = [];
          const subEmit = (e: any) => {
            if (e.type === "text_delta") captured.push(e.text);
            emit({ ...e, delegateId: tu.id }); // nest under the delegation card in the UI
          };
          try {
            await runAgent(run, sub, task, subEmit, depth + 1);
          } catch (e) {
            subEmit({ type: "error", message: (e as Error).message });
          }
          emit({ type: "delegate_end", id: tu.id, agentId: sub.id });
          resultText =
            captured.join("").trim().slice(0, 8000) ||
            "(sub-agent completed; its output/artifact is available)";
        }
      } else if (tu.name === "record_claim") {
        const r = handleRecordClaim(project, agent.id, runId, (tu.input ?? {}) as Record<string, unknown>);
        emit({ type: "tool_result", id: tu.id, name: tu.name, result: r.text });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: r.text, ...(r.isError ? { is_error: true } : {}) });
        continue;
      } else if (tu.name === "compare_sources" && isDocAgent) {
        const r = handleCompareSources(project, userMessage, agent.id, runId, commit);
        conflictsFound = r.conflicts;
        emit({ type: "tool_result", id: tu.id, name: tu.name, result: r.text });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: r.text });
        continue;
      } else {
        // Phase 3 — hard template binding. A template that names THIS agent must be
        // read before the agent is allowed to save a deliverable. Enforced here rather
        // than asked for in the prompt, so it can't be skipped.
        //
        // propose_file_change modifying a real file adds its own targetPath to what
        // must have been read this run — the same rule save_artifact already applies
        // to named inputs, extended to the file the change is against.
        let effectiveRequired =
          tu.name === "propose_file_change" && (tu.input as any)?.kind === "modify"
            ? [...required, String((tu.input as any)?.targetPath ?? "")]
            : required;
        // A document-sourced deliverable must rest on every input document, not whichever
        // the agent got to: in a live run the agent read both, but nothing made it.
        if ((tu.name === "save_artifact" || tu.name === "write_section" || tu.name === "draft_requirements") && isDocAgent && project) {
          const inputs = walkFiles(inputsDirOf(project), project.artifactsDir).map((f) => f.path);
          effectiveRequired = [...new Set([...effectiveRequired, ...inputs])];
        }
        // Drafting requirements writes the deliverable too, so it is held to the same gates as write_section.
        const gateName = tu.name === "draft_requirements" ? "write_section" : tu.name;
        const gate =
          templateGate(agent.id, gateName, goldenReadThisRun, project) ??
          prerequisiteGate(gateName, effectiveRequired, readOk, failedArtifactReads);
        if (gate) {
          resultText = gate;
          emit({ type: "tool_result", id: tu.id, name: tu.name, result: resultText });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: resultText, is_error: true });
          continue;
        }
        // A document built with write_section is already saved, composed and checked after every section. A live
        // run re-sent its whole 144K-character document with save_artifact "to save the final version": 10.8 minutes
        // of output (28% of the run) for what the server already holds, and later patches then composed from the
        // sections, not from that copy. Refused, with the way to what was wanted.
        if (tu.name === "save_artifact" && isDocAgent && sectionDocs.has(String((tu.input as any)?.name ?? "").trim())) {
          const sName = String((tu.input as any)?.name ?? "").trim();
          resultText =
            `Refused: \`${sName}\` is being built with write_section, and the server has already saved it in full after your last section (${sectionDocs.get(sName)!.compose().length.toLocaleString("en-US")} characters). ` +
            `Re-sending the whole document costs minutes and changes nothing. To change something, use patch_section (exact text) or write_section for one section; call check_document to run the whole-document checks; then give your final answer.`;
          console.error(`[guard] ${agent.id}: refused save_artifact of ${sName} — it is built with write_section`);
          emit({ type: "tool_result", id: tu.id, name: tu.name, result: resultText });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: resultText, is_error: true });
          continue;
        }
        // A save that would replace a long document with a much shorter one is refused once;
        // sending the same content again lets it through (see guards.ts for why).
        if (tu.name === "save_artifact") {
          const sName = String((tu.input as any)?.name ?? "");
          const sContent = String((tu.input as any)?.content ?? "");
          const prior = existingArtifact(project, sName);
          const refusal = destructiveSave({
            kind: "document", newLen: sContent.length, prevLen: prior ? prior.length : null, name: sName,
            prevCitations: prior?.citations, newCitations: countCitations(sContent),
            prevIds: prior?.ids, newIds: countIds(sContent),
          });
          const sKey = contentKey(sName, sContent);
          if (refusal && !refusedSaves.has(sKey)) {
            refusedSaves.add(sKey);
            console.error(`[guard] ${agent.id}: refused a save of ${sName} (${sContent.length} chars over an existing document)`);
            resultText = refusal;
            emit({ type: "tool_result", id: tu.id, name: tu.name, result: resultText });
            results.push({ type: "tool_result", tool_use_id: tu.id, content: resultText, is_error: true });
            continue;
          }
        }
        try {
          const args = { ...((tu.input ?? {}) as Record<string, unknown>) };
          // Stamp provenance into the document itself. An artifact gets detached from
          // the conversation that produced it — mailed, pasted into a ticket, reviewed
          // weeks later — and Round 2 could not tie artifacts back to a project or a
          // commit. Markdown only: a footer in a .cs file would not compile.
          if (tu.name === "save_artifact" && currentRun && stampable(String(args.name ?? ""))) {
            args.content = `${String(args.content ?? "")}${identityFooter(currentRun)}`;
          }
          // A section an area writer is still drafting belongs to it until the areas are in.
          const running = draftJobs.filter((j) => !j.done);
          const touches = (tu.name === "write_section" || tu.name === "patch_section") && running.length
            ? [String(args.section ?? ""), ...(Array.isArray(args.sections) ? (args.sections as any[]).map((s) => String(s?.section ?? "")) : [])].filter((s) => s && running.some((j) => j.sections.has(sectionKey(s))))
            : [];
          const sctx = { ws, project, agentId: agent.id, task: userMessage, conflicts: conflictsFound, docs: sectionDocs, refused: refusedSaves, paths: sectionPaths, emit, perf };
          if (touches.length) {
            resultText = `Refused: “${touches[0]}” is being drafted in parallel and will be replaced when it is done. Write the other chapters now; call check_document when they are done (it waits for the drafts), then patch what it reports.`;
          } else if (tu.name === "draft_requirements" && isDocAgent) {
            if (running.some((j) => j.kind === "requirements")) {
              resultText = "Refused: requirement areas are already being drafted. Write the other chapters, then call check_document.";
            } else {
              const r = await startDraftRequirements({ ...sctx, memory: reviewMemory }, args, draftRefused);
              resultText = r.text;
              if (r.job) draftJobs.push(r.job);
            }
          } else if (tu.name === "draft_chapters" && isDocAgent) {
            const r = await startDraftChapters(sctx, args);
            resultText = r.text;
            if (r.job) draftJobs.push(r.job);
          } else if (tu.name === "write_section" && isDocAgent) {
            const r = await handleWriteSection({ ws, project, agentId: agent.id, task: userMessage, conflicts: conflictsFound, docs: sectionDocs, refused: refusedSaves, paths: sectionPaths }, args);
            resultText = r.text;
            if (r.saved) {
              savedThisRun.add(r.saved.path);
              lastDocSaved = { name: r.saved.name, content: r.saved.content };
            }
          } else if (tu.name === "patch_section" && isDocAgent) {
            const r = await handlePatchSection({ ws, project, agentId: agent.id, task: userMessage, conflicts: conflictsFound, docs: sectionDocs, refused: refusedSaves, paths: sectionPaths }, args);
            resultText = r.text;
            if (r.saved) {
              savedThisRun.add(r.saved.path);
              lastDocSaved = { name: r.saved.name, content: r.saved.content };
            }
          } else if (tu.name === "check_document" && isDocAgent && draftJobs.length && checksDone >= DRAFTED_CHECK_LIMIT) {
            resultText = `No more whole-document checks in this run (${DRAFTED_CHECK_LIMIT} done). Give your final answer now: say what was saved and name anything the last check reported that you did not fix.`;
          } else if (tu.name === "check_document" && isDocAgent) {
            checksDone++;
            const drafted = await settleDrafts();
            const fixable = draftJobs.filter((j) => j.fix);
            const refixAreas = DRAFT_REFIX && fixable.length && !areasRefixed
              ? async (artifact: string, doc: SectionedDoc, report: ReviewReport | undefined) => {
                  areasRefixed = true; // once a run: what is left after it goes to the writer of the whole document
                  const r = await fixAreasFromReview(sctx, fixable, doc, artifact, report);
                  if (r.saved) { savedThisRun.add(r.saved.path); lastDocSaved = { name: r.saved.name, content: r.saved.content }; }
                  const resets = r.depResets?.length ? ` ⚠ Dependencies reset to “Not Specified” in the fix pass (kept under Open Questions as “Dependency to confirm”): ${r.depResets.join("; ")}.` : "";
                  return r.changed ? `**${r.changed} drafted section(s) were corrected by their own writers** from the reviewer's findings and the server's checks before these checks ran; what follows is what is still open.${resets}` : null;
                }
              : undefined;
            resultText = (drafted ? `${drafted}\n\n---\n\n` : "") + (await handleCheckDocument({ ...sctx, review: reviewMemory, refixAreas, drafted: draftJobs.length > 0 }, args)).text;
            const d = sectionDocs.get(String(args.artifact ?? "").trim());
            if (d) lastDocSaved = { name: String(args.artifact).trim(), content: d.compose() };
            if (draftJobs.length && checksDone >= DRAFTED_CHECK_LIMIT)
              resultText += `\n\n**This was the last whole-document check of this run.** Fix what you can from it in one batched patch_section call (fail findings first), then give your final answer without checking again.`;
            else if (draftJobs.length)
              resultText += `\n\n(Whole-document check ${checksDone} of ${DRAFTED_CHECK_LIMIT} for this run.)`;
          } else {
            resultText = await callMcpTool(ws, tu.name, args);
          }
          if (tu.name === "golden_read") {
            const id = String((tu.input as any)?.id ?? "").trim().toUpperCase();
            if (id && !resultText.startsWith("'")) goldenReadThisRun.add(id); // '…' = refusal
          }
          if (tu.name === "read_artifact") {
            const asked = String((tu.input as any)?.name ?? "").trim();
            if (resultText.startsWith("Artifact not found:")) {
              if (asked) failedArtifactReads.add(asked);
            } else if (asked && !resultText.startsWith("Refused:")) {
              // Only this name clears itself. Reading something else is not a recovery.
              failedArtifactReads.delete(asked);
              // A truncated read of an input document is not having read it: the first
              // 20,000 characters of a 120,000-character source is how a deliverable ends
              // up resting on a fraction of it.
              const partial = asked.startsWith("inputs/") && /…\s*\(truncated/.test(resultText);
              if (!partial) readOk.add(asked);
            }
          }
          if (tu.name === "read_file" && !/^(?:ERROR|Refused:|Could not|No such)/.test(resultText)) {
            const p = String((tu.input as any)?.path ?? "").trim();
            if (p) readOk.add(p);   // a named prerequisite is often source, not an artifact
          }
          if (tu.name === "save_artifact") {
            // "Saved artifact to `path`", "Updated existing artifact `path`",
            // "Artifact `path` already contains…" — "Refused:" deliberately matches none.
            const m = resultText.match(/^(?:Saved artifact to|Updated existing artifact|Artifact) `([^`]+)`/);
            if (m) savedThisRun.add(m[1]);
            // Tell the agent what is wrong with what it just saved while it can still fix
            // it — a warning appended to the final answer comes too late to act on.
            const savedName = String((tu.input as any)?.name ?? "");
            if (m && !/^Artifact `/.test(resultText) && stampable(savedName)) {
              const content = String((tu.input as any)?.content ?? "");
              if (isDocAgent) lastDocSaved = { name: savedName, content };
              const notes = postSaveChecks(content, userMessage, agent.id, project, conflictsFound, isDocAgent);
              if (notes) {
                resultText += notes;
                console.error(`[checks] ${agent.id} saved ${savedName} with flagged content`);
              }
            }
          }
          if (tu.name === "propose_file_change") {
            // "Proposed change to `path` (kind) — …" — a proposal is a written
            // deliverable too, so the saved-claim check has to recognise it as one.
            const m = resultText.match(/^Proposed change to `([^`]+)`/);
            if (m) {
              savedThisRun.add(m[1]);
              proposedThisRun.add(m[1]);
              resultText += await auditProposal(ws, project, (tu.input ?? {}) as Record<string, unknown>, resultText, { runId, commit, agentId: agent.id });
            }
          }
          // Last, after every tracker above has read the raw result: record what the
          // tool observed and hand the agent the ID, so a later claim can cite it.
          if (isEvidenceTool(tu.name) && !isErrorResult(resultText)) {
            const a = (tu.input ?? {}) as Record<string, unknown>;
            const rec = evidence.addObservation({
              runId, projectId: project?.id ?? "", agent: agent.id, tool: tu.name,
              args: summarizeArgs(a), outputHash: sha256(resultText),
              excerpt: resultText.slice(0, 300), commit,
              files: project?.sourceRoot
                ? snapshotFiles(project.sourceRoot, evidenceFilesFor(tu.name, a, resultText))
                : [],
            });
            resultText += `\n\n[evidence ${rec.id}]`;
          }
        } catch (e) {
          resultText = `ERROR: ${(e as Error).message}`;
        }
        emit({ type: "tool_result", id: tu.id, name: tu.name, result: resultText });
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: resultText });
    }
    messages.push({ role: "user", content: results });
  }

  // A run cut off by the turn limit must not leave areas writing into the document behind it.
  if (pendingJob()) await settleDrafts();

  if (depth === 0) {
    const summary = perf.summary();
    console.error(formatPerf(summary));
    rawEmit({ type: "perf", ...summary });
    // Said, not silent: a corrected citation is still one the writers got wrong.
    for (const [name, d] of sectionDocs) if (d.citationRewrites) {
      const line = `${d.citationRewrites} citation(s) in ${name} were written as files under inputs/ (inputs/GLD-…) and rewritten to the Golden Repository id`;
      console.error(`[citations] ${line}`);
      rawEmit({ type: "notice", message: line });
    }
    // What became of every source item, and what was asked for but not used: counted for the run, not only when open.
    if (isDocAgent && lastDocSaved) {
      const all = documentSources(project, userMessage);
      const summary = summarizeItemLedger(itemLedger(fieldRowsAsLabels(lastDocSaved.content), clientDocumentMap(all)));
      console.error(`[items] ${lastDocSaved.name}: ${summary}`);
      rawEmit({ type: "notice", message: `${lastDocSaved.name}: ${summary}` });
      const degraded = sourceDegradation(project, userMessage);
      if (degraded.length) {
        console.error(`[sources] asked for but not used: ${degraded.join("; ")}`);
        rawEmit({ type: "notice", message: `Sources asked for but not used: ${degraded.join("; ")}` });
      }
    }
  }

  // If we exhausted the turn budget mid-work (last turn still wanted tools),
  // surface it in the answer rather than stopping silently.
  if (lastStop === "tool_use") {
    const note = `\n\n_⚠ **Analysis was cut off at the ${MAX_TURNS}-step limit** — the results above are partial. This usually means the target is large or not fully indexed (the code index is optimized for .NET/C#; other stacks are searched but not symbol-indexed). Try a narrower, more specific prompt, or raise \`MAX_TURNS_PER_RUN\`._`;
    emit({ type: "text_delta", text: note });
    outText += note;
  }

  // A citation is the whole promise of the Golden Repository: it tells a reader
  // "this claim rests on your organisation's actual standard". Agents were
  // observed citing standards they never opened, which makes that promise
  // unverifiable by eye — a hollow citation looks exactly like a real one.
  // This is a factual comparison against what the run actually read, so it
  // cannot be prompted away.
  // The answer as the agent wrote it. Every check below reads this rather than the
  // running total, because each one appends a warning that quotes the lines it
  // flagged — and the next check would then scan those quotes and report the same
  // sentence again under a different heading.
  const written = outText;

  const cited = [...new Set(
    [...written.matchAll(/\b(GLD-[A-Z]+-\d+)@\d+/g)].map((m) => m[1].toUpperCase())
  )];
  const unread = cited.filter((id) => !goldenReadThisRun.has(id));

  if (unread.length) {
    const note =
      `\n\n_⚠ **Unverified citation${unread.length > 1 ? "s" : ""}:** ` +
      `${unread.join(", ")} ${unread.length > 1 ? "were" : "was"} cited above but never opened during this run. ` +
      `The wording may still be right, but it was written from the catalog summary rather than the document — ` +
      `treat ${unread.length > 1 ? "those claims" : "that claim"} as unverified until checked against the source._`;
    emit({ type: "text_delta", text: note });
    outText += note;
    console.error(`[golden] ${agent.id} cited without reading: ${unread.join(", ")}`);
  }

  // The agent is shown these checks on every save but is free to stop with some still open
  // (a live run's citation misses went 20, 16, 7, 15, 37 across five saves). Whoever reads
  // the answer should be told, not left to find it in a tool result.
  if (isDocAgent && lastDocSaved) {
    const open = documentChecks(lastDocSaved.content, userMessage, agent.id, project, conflictsFound, true);
    if (open.length) {
      const note =
        `\n\n_⚠ **\`${lastDocSaved.name}\` was saved with checks still open.** The server compared the final saved version with its sources and the task:_\n\n` +
        open.join("\n\n");
      emit({ type: "text_delta", text: note });
      outText += note;
      console.error(`[checks] ${agent.id} finished with ${open.length} check(s) still open on ${lastDocSaved.name}`);
    }
  }

  // Run-level, because a test proposed after its source would otherwise be missed at the
  // moment the source was audited. Says only that this change set has no test in it.
  const untested = proposalsWithoutTests([...proposedThisRun]);
  if (untested.length) {
    const note =
      `\n\n_ℹ **No test change was proposed alongside:** ${untested.map((p) => `\`${p}\``).join(", ")}. ` +
      `Existing tests elsewhere in the repository may already cover ${untested.length > 1 ? "them" : "it"} — this run's proposals include none._`;
    emit({ type: "text_delta", text: note });
    outText += note;
  }

  // The same lookup for the evidence ledger: an ID the agent writes that no tool ever
  // returned is invented, and reads exactly like a real one.
  const unknownIds = unknownEvidenceCitations(written, evidence.knownIds(project?.id ?? ""));
  if (unknownIds.length) {
    const note =
      `\n\n_⚠ **Unknown evidence reference${unknownIds.length > 1 ? "s" : ""}:** ` +
      `${unknownIds.join(", ")} ${unknownIds.length > 1 ? "do" : "does"} not exist in this project's evidence ledger. ` +
      `Evidence IDs are issued by the server when a tool returns a result; ${unknownIds.length > 1 ? "these were" : "this was"} not. ` +
      `Treat the surrounding claim${unknownIds.length > 1 ? "s" : ""} as unsupported._`;
    emit({ type: "text_delta", text: note });
    outText += note;
    console.error(`[evidence] ${agent.id} cited unknown ids: ${unknownIds.join(", ")}`);
  }

  // Same idea as the citation check, applied to claims about the running world.
  // Static tools cannot see a deployment or a test result, so these sentences are
  // describing something this run did not observe — whatever their wording implies.
  const overreach = unprovenClaims(written);
  if (overreach.length) {
    const note =
      `\n\n_⚠ **Unproven claim${overreach.length > 1 ? "s" : ""} about runtime or test state:** ` +
      `every tool available here is static — nothing was deployed, executed, compiled or measured during this run. ` +
      `${overreach.length > 1 ? "These sentences read" : "This sentence reads"} as observed fact:_\n` +
      overreach.map((s) => `> ${s}`).join("\n") +
      `\n\n_Treat ${overreach.length > 1 ? "them" : "it"} as inference until confirmed against a real environment._`;
    emit({ type: "text_delta", text: note });
    outText += note;
    console.error(`[precision] ${agent.id} unproven runtime/test claims: ${overreach.length}`);
  }

  // "Backward compatible" is five questions in one coat, and the reader acts on the
  // answer. Naming a kind clears this — it forces the question, it does not grade it.
  const vague = unqualifiedCompatibility(written);
  if (vague.length) {
    const one = vague.length === 1;
    const note =
      `\n\n_⚠ **Compatibility verdict without a kind:** source, binary, schema, serialization, ` +
      `package and migration compatibility fail independently — a signature unchanged in source can ` +
      `still break every compiled caller. ${one ? "This verdict does" : "These verdicts do"} not say which:_\n` +
      vague.map((s) => `> ${s}`).join("\n") +
      `\n\n_Name the kind you checked, and the kinds you did not._`;
    emit({ type: "text_delta", text: note });
    outText += note;
    console.error(`[compat] ${agent.id} unqualified compatibility verdicts: ${vague.length}`);
  }

  // "Saved" has to survive someone going to look for it. This compares the answer's
  // own words against what the tool actually wrote — not a judgement, a lookup.
  const phantom = unsavedArtifactClaims(written, savedThisRun);
  if (phantom.length) {
    const one = phantom.length === 1;
    const note =
      `\n\n_⚠ **Artifact${one ? "" : "s"} reported as saved but not written this run:** ` +
      `${phantom.map((p) => `\`${p}\``).join(", ")}. ` +
      `Nothing by that name was persisted, so ${one ? "it" : "they"} cannot be retrieved or reviewed. ` +
      `Treat the content above as response text only, and save it explicitly if it is meant to last._`;
    emit({ type: "text_delta", text: note });
    outText += note;
    console.error(`[artifacts] ${agent.id} claimed unsaved: ${phantom.join(", ")}`);
  }

  // Record what this run consulted. A run that opened nothing still counts —
  // "agents ran 40 times and never opened this standard" is the finding, and
  // dropping those rows would quietly flatter the library.
  void goldenUsage.record({
    at: new Date().toISOString(),
    agent: agent.id,
    project: project?.id ?? "",
    read: [...goldenReadThisRun],
    cited,
    unverified: unread,
  });

  return outText;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

let agents: Agent[] = [];

app.get("/api/agents", async (req, res) => {
  const { project, ws } = await contextOf(req, res);
  const mcpTools = ws?.tools ?? [];
  // Curated demo prompts apply to the bundled demo *or* any project that is nopCommerce
  // (e.g. mounted at /workspace in Docker/Azure, where the project id is "workspace").
  const demo = project?.id === DEMO_ID || /nopcommerce/i.test(project?.sourceRoot ?? "");
  res.json(
    agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      tools: a.id === ORCH_ID
        ? ["delegate", ...a.tools.filter((t) => mcpTools.some((m) => m.name === t))]
        : a.tools.filter((t) => mcpTools.some((m) => m.name === t)),
      suggested: (demo ? SUGGESTED[a.id] : GENERIC_SUGGESTED[a.id]) ?? GENERIC_SUGGESTED[a.id] ?? [],
    }))
  );
});

app.get("/api/health", async (req, res) => {
  const { project: p, ws } = await contextOf(req, res);
  res.json({
    mcpReady: ws?.ready ?? false,
    mcpError: ws?.error ?? null,
    // Distinguish "still indexing" from "broken" — the UI can say which, and a
    // monitor can tell a slow start from an outage.
    indexing: Boolean(ws?.opening),
    mcpTools: (ws?.tools ?? []).map((t) => t.name),
    workspacesOpen: workspaces.size,
    model: MODEL,
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    activeProject: p ? publicProject(p) : null,
    // Prompt-cache totals since boot. hitRate near 0 after a few agent runs means
    // something is invalidating the prefix — the numbers are the only way to tell.
    cache: {
      ...cacheStats,
      hitRate: cacheStats.read + cacheStats.uncached
        ? +(cacheStats.read / (cacheStats.read + cacheStats.uncached)).toFixed(3)
        : null,
    },
    // Lets the UI explain that "local folder" means a folder on the server.
    host: { platform: process.platform, cloud: IS_CLOUD, maxUploadMb: MAX_UPLOAD_MB },
  });
});

// ---- Settings API (in-app key / model) -----------------------------------
function settingsView() {
  const k = process.env.ANTHROPIC_API_KEY || "";
  return {
    hasApiKey: Boolean(k),
    keyHint: k ? "…" + k.slice(-4) : "",
    model: MODEL,
    // Which of the two possible sources is actually in force. Without this, an admin
    // rotating the deployment's key has no way to tell that an in-app override is
    // quietly winning.
    keySource,
    canFallBackToEnvironment: Boolean(envApiKey),
  };
}
/**
 * Recent operational history — what was slow, and what stopped early.
 *
 * Answers the questions that otherwise need container log access: how long an upload
 * spent in each phase, how long a project took to become usable, and which runs hit
 * the step limit. Newest last, capped, and holding no prompts, answers or secrets.
 */
app.get("/api/diagnostics", (_req, res) => {
  const runs = diagnostics.runs;
  const cutOff = runs.filter((r) => r.cutOff);
  res.json({
    now: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    // `az webapp config appsettings set` echoes every value back as null on this
    // deployment's CLI version — its own response cannot confirm a setting took.
    // What the running process actually read at boot is the only thing that can.
    limits: { stepLimit: MAX_TURNS, toolTimeoutMs: MCP_TIMEOUT_MS, maxWorkspaces: MAX_WORKSPACES, maxUploadMb: MAX_UPLOAD_MB, maxTokens: MAX_TOKENS },
    workspacesOpen: [...workspaces.values()].map((w) => ({
      project: w.projectId, ready: w.ready, opening: Boolean(w.opening), error: w.error,
    })),
    summary: {
      runs: runs.length,
      runsCutOff: cutOff.length,
      // Which agent and project pairing runs out of steps is the actionable part.
      cutOffBy: [...new Set(cutOff.map((r) => `${r.agent} on ${r.project}`))].slice(0, 10),
      slowestUploadSec: diagnostics.uploads.reduce((m, u) => Math.max(m, u.totalSec ?? 0), 0),
      slowestOpenSec: diagnostics.workspaces.reduce((m, w) => Math.max(m, w.totalSec ?? 0), 0),
    },
    uploads: diagnostics.uploads,
    workspaces: diagnostics.workspaces,
    runs,
  });
});

app.get("/api/settings", (_req, res) => res.json(settingsView()));
app.post("/api/settings", (req, res) => {
  try {
    applySettings(req.body ?? {});
    res.json({ ok: true, ...settingsView() });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// ---- Golden Repository API (admin) ---------------------------------------
// One org-wide library; projects select from it. Content is uploaded or pasted,
// normalised to markdown, and stored outside the hot index file.

app.get("/api/golden", (req, res) => {
  const includeArchived = String(req.query.includeArchived) === "true";
  const items = golden.list({ includeArchived });
  res.json({ items, catalogCap: CATALOG_CAP, dir: GOLDEN_DIR });
});

/**
 * Is the library working? Joins each item against what agents actually consulted.
 * MUST stay above `/:id` or "health" is read as an item id.
 */
// The ledger for the active project, with freshness computed now against the files on
// disk — a stored verdict would go stale exactly when it matters.
app.get("/api/evidence", async (req, res) => {
  const { project } = await contextOf(req, res);
  if (!project) { res.json({ project: null, evidence: [], claims: [], summary: null }); return; }

  const all = evidence.forProject(project.id);
  const recent = all.evidence.slice(-200).reverse();
  const fresh = new Map<string, Freshness>();
  for (const e of all.evidence) fresh.set(e.id, freshnessOf(e, project.sourceRoot));

  const claims = all.claims.slice(-100).reverse().map((c) => ({
    ...c,
    status: claimStatus(c, fresh),
    evidenceFreshness: Object.fromEntries(c.evidence.map((id) => [id, fresh.get(id) ?? "stale"])),
  }));
  const count = (f: Freshness) => [...fresh.values()].filter((v) => v === f).length;
  res.json({
    project: { id: project.id, name: project.name },
    evidence: recent.map((e) => ({ ...e, freshness: fresh.get(e.id) })),
    claims,
    summary: {
      evidence: all.evidence.length,
      fresh: count("fresh"), stale: count("stale"), unscoped: count("unscoped"),
      claims: all.claims.length,
      unsupported: claims.filter((c) => c.status === "unsupported").length,
      staleClaims: claims.filter((c) => c.status === "stale").length,
    },
  });
});

app.get("/api/golden/health", (_req, res) => {
  const { runs, since, byItem } = goldenUsage.health();
  const items = golden.list({ includeArchived: false }).map((i) => {
    const h = byItem.get(i.id.toUpperCase()) ?? byItem.get(i.id);
    return {
      id: i.id, title: i.title, kind: i.kind,
      enforcement: i.enforcement, status: i.status,
      // Agents only ever see published items, so an unpublished one is not
      // "unused" — it was never in the room. Keep the two apart.
      visible: i.status === "published",
      reads: h?.reads ?? 0,
      citations: h?.citations ?? 0,
      unverified: h?.unverified ?? 0,
      lastUsed: h?.lastUsed ?? null,
      agents: h?.agents ?? [],
    };
  });

  const visible = items.filter((i) => i.visible);
  res.json({
    runs, since, items,
    summary: {
      total: items.length,
      hidden: items.length - visible.length,
      neverRead: visible.filter((i) => i.reads === 0).length,
      unverified: items.reduce((n, i) => n + i.unverified, 0),
    },
  });
});

app.get("/api/golden/:id", (req, res) => {
  const item = golden.get(req.params.id);
  if (!item) { res.status(404).json({ ok: false, error: "Not found" }); return; }
  res.json({ ok: true, item, content: golden.readContent(item.id) ?? "" });
});

/** A scope must name a real project — a typo would otherwise hide the item from everyone. */
function validScope(raw: unknown): string | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  if (!projects.some((p) => p.id === s)) throw new Error(`No such project to scope this to: ${s}`);
  return s;
}

app.post("/api/golden", async (req, res) => {
  try {
    const b = req.body ?? {};
    const scope = validScope(b.scope);
    const item = await golden.create({
      scope,
      title: String(b.title ?? ""),
      description: b.description ? String(b.description) : undefined,
      kind: (b.kind ?? "reference") as GoldenKind,
      enforcement: b.enforcement, appliesTo: b.appliesTo, tags: b.tags, aliases: b.aliases,
      owner: b.owner, approvedBy: b.approvedBy, status: b.status,
      content: String(b.content ?? ""), sourceName: b.sourceName,
    });
    refreshGoldenForActiveProject();
    res.json({ ok: true, item });
  } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
});

/**
 * Word/PDF → Markdown for the editor. Deliberately does NOT create the item:
 * a conversion can lose clause numbering, or come back empty from a scanned PDF,
 * and publishing that unseen would put a hollow "standard" in front of agents.
 * The admin reviews the text and saves.
 *
 * MUST stay above `/api/golden/:id` — Express matches in registration order, and
 * registered after it this path was swallowed as an item id ("No such golden
 * item: convert").
 */
const MAX_DOC_MB = Number(process.env.MAX_DOC_MB ?? 25);

app.post("/api/golden/convert", async (req, res) => {
  const filename = String(req.query.filename || "document").trim();
  try {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared && declared > MAX_DOC_MB * 1024 * 1024)
      throw new Error(`That file is ${(declared / 1048576).toFixed(1)} MB — the limit is ${MAX_DOC_MB} MB.`);

    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_DOC_MB * 1024 * 1024) {
          req.pause(); req.resume();          // drain, don't kill the socket
          reject(new Error(`That file is larger than the ${MAX_DOC_MB} MB limit.`));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve());
      req.on("error", reject);
    });

    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error("The upload was empty.");

    const out = await convertDocument(buf, filename);
    console.error(`[golden] converted ${out.kind} "${filename}" — ${out.stats.chars} chars, ${out.stats.headings} heading(s), ${out.warnings.length} warning(s)`);
    res.json({ ok: true, ...out, suggestedTitle: filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

/**
 * Bulk import — a zip of documents becomes Golden Repository items in one step.
 *
 * Adding items one at a time is fine for a handful and impractical for a real
 * standards library (the pack this was built against has 199 files), which made
 * it the thing standing between a team and using the feature at all.
 *
 * Everything lands as **draft / reference**, never published and never mandatory.
 * A bulk action must not be able to silently put a document in front of every
 * agent as an enforced rule — publishing stays a deliberate, per-item decision
 * (and a mandatory item still needs a named approver).
 *
 * MUST stay above `/api/golden/:id` — Express matches in registration order.
 */
const IMPORT_EXT = new Set([".md", ".markdown", ".txt", ".docx", ".pdf"]);
const MAX_IMPORT_FILES = Number(process.env.MAX_IMPORT_FILES ?? 300);

/** First heading or first non-empty line — the one-liner agents see in the catalog. */
function deriveDescription(md: string, fallback: string): string {
  for (const raw of md.split("\n").slice(0, 40)) {
    const line = raw.replace(/^#+\s*/, "").replace(/[*_`>|-]/g, " ").trim();
    if (line.length > 15 && !/^\s*$/.test(line)) return line.slice(0, 220);
  }
  return fallback;
}

app.post("/api/golden/import", async (req, res) => {
  const alive = keepJsonAlive(res); // extraction + conversion runs long and silent
  try {
    // ?scope=<projectId> makes everything imported visible to that project only.
    const scope = validScope(req.query.scope);
    const declared = Number(req.headers["content-length"] || 0);
    if (declared && declared > MAX_UPLOAD_MB * 1024 * 1024)
      throw new Error(`That zip is ${(declared / 1048576).toFixed(0)} MB — the limit is ${MAX_UPLOAD_MB} MB.`);

    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_UPLOAD_MB * 1024 * 1024) { req.pause(); req.resume();
          reject(new Error(`That zip is larger than the ${MAX_UPLOAD_MB} MB limit.`)); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve());
      req.on("error", reject);
    });
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error("The upload was empty.");
    if (!(buf[0] === 0x50 && buf[1] === 0x4b)) throw new Error("That is not a .zip file.");

    // Read entries straight out of the archive. Nothing is written to disk, so
    // there is no zip-slip surface and no dependency on an `unzip` binary being
    // present (it is not, on Windows).
    const zip = await JSZip.loadAsync(buf);
    const found = Object.values(zip.files)
      .filter((f: any) => !f.dir)
      .filter((f: any) => {
        const n = f.name;
        if (n.includes("__MACOSX/") || n.split("/").some((s: string) => s.startsWith("."))) return false;
        return IMPORT_EXT.has(path.extname(n).toLowerCase());
      })
      .sort((a: any, b: any) => a.name.localeCompare(b.name));

    const imported: any[] = [];
    const skipped: any[] = [];
    for (const entry of found.slice(0, MAX_IMPORT_FILES) as any[]) {
      // Strip a single wrapping folder so "Pack/09_Security/x.md" tags as "security".
      const parts = entry.name.split("/").filter(Boolean);
      const rel = (parts.length > 1 && found.every((f: any) => f.name.startsWith(parts[0] + "/")))
        ? parts.slice(1).join("/") : parts.join("/");
      const base = path.basename(rel, path.extname(rel));
      try {
        const ext = path.extname(rel).toLowerCase();
        let content: string;
        let warnings: string[] = [];
        if (ext === ".docx" || ext === ".pdf") {
          const out = await convertDocument(await entry.async("nodebuffer"), path.basename(rel));
          content = out.markdown; warnings = out.warnings;
        } else {
          content = await entry.async("string");
        }
        if (!content.trim()) { skipped.push({ file: rel, reason: "empty" }); continue; }

        // Top-level folder makes a sensible starting tag — it is how these packs
        // are already organised (10_Coding_Standards, 09_Security, …).
        const top = rel.includes("/") ? rel.split("/")[0] : "";
        const tag = top.replace(/^\d+[_-]/, "").replace(/[_\s]+/g, "-").toLowerCase();

        const item = await golden.create({
          title: base.replace(/[_-]+/g, " ").trim(),
          description: deriveDescription(content, `Imported from ${rel}`),
          kind: "reference",
          enforcement: "reference",
          status: "draft",                     // never auto-publish
          scope,
          appliesTo: ["all"],
          tags: tag ? [tag] : [],
          owner: "imported",
          sourceName: rel,
          content,
        });
        imported.push({
          file: rel, id: item.id, chars: item.contentChars,
          warnings: warnings.filter((w) => w.startsWith("SECURITY")),
        });
      } catch (e) {
        skipped.push({ file: rel, reason: (e as Error).message.slice(0, 160) });
      }
    }

    refreshGoldenForActiveProject();
    alive.send(200, {
      ok: true,
      imported: imported.length,
      skipped: skipped.length,
      overCap: found.length > MAX_IMPORT_FILES ? found.length - MAX_IMPORT_FILES : 0,
      flagged: imported.filter((i) => i.warnings.length).length,
      items: imported, skippedItems: skipped,
    });
  } catch (e) {
    alive.send(400, { ok: false, error: (e as Error).message });
  }
});

app.post("/api/golden/:id", async (req, res) => {
  try {
    const item = await golden.update(req.params.id, req.body ?? {});
    refreshGoldenForActiveProject();
    res.json({ ok: true, item });
  } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
});

app.post("/api/golden/:id/archive", async (req, res) => {
  try {
    const item = await golden.archive(req.params.id);
    refreshGoldenForActiveProject();
    res.json({ ok: true, item });
  } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
});

/**
 * Test-run a golden item (Phase 4). Runs a real agent against the active project and
 * reports whether the item was actually picked up — the feedback loop an author needs
 * to know their skill/standard works, and the thing the test report asked for
 * (evidence, not assertion).
 */
app.post("/api/golden/:id/test", async (req, res) => {
  const item = golden.get(req.params.id);
  if (!item) { res.status(404).json({ ok: false, error: "Not found" }); return; }
  const run = await runContextOf(req, res);
  if (!run.ws.ready) { res.status(409).json({ ok: false, error: run.ws.error ?? "Load a project first — a test run needs a codebase." }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(409).json({ ok: false, error: "Set an API key in Settings to run a test." }); return; }

  const agentId = String(req.body?.agentId ?? "");
  const task = String(req.body?.task ?? "").trim();
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) { res.status(400).json({ ok: false, error: "Pick an agent to run the test with." }); return; }
  if (!task) { res.status(400).json({ ok: false, error: "Describe a task to test the item against." }); return; }

  const alive = keepJsonAlive(res);
  const used: string[] = [];
  try {
    const answer = await runAgent(run, agent, task, (e: any) => {
      if (e.type === "tool_call" && e.name === "golden_read") {
        const id = String(e.input?.id ?? "").trim().toUpperCase();
        if (id) used.push(id);
      }
    }, 0);
    const picked = used.includes(item.id.toUpperCase());
    alive.send(200, {
      ok: true, itemId: item.id, agent: agent.name,
      pickedUp: picked,
      goldenRead: [...new Set(used)],
      citedIdVersion: new RegExp(`${item.id}@\\d+`, "i").test(answer),
      answer: answer.slice(0, 8000),
      verdict: picked
        ? "The agent read this item during the run."
        : "The agent did NOT read this item. Usually the description or appliesTo doesn't match the task — sharpen the description so it's obvious when this applies.",
    });
  } catch (e) {
    alive.send(500, { ok: false, error: (e as Error).message });
  }
});

/** What the ACTIVE project's agents would currently see (admin preview / debugging). */
app.get("/api/golden-selection", (req, res) => {
  const { state } = sessionOf(req, res);
  const p = projects.find((x) => x.id === state.projectId);
  const selected = golden.selectedFor(p?.golden, p?.id);
  res.json({
    projectId: p?.id ?? null,
    selection: p?.golden ?? { mode: "all" },
    selectedIds: selected.map((i) => i.id),
    selectedCount: selected.length,
    mandatoryCount: selected.filter((i) => i.enforcement === "mandatory" && i.status === "published").length,
    catalogCap: CATALOG_CAP,
    overCap: selected.filter((i) => i.status === "published").length > CATALOG_CAP,
  });
});

/** Branches available for review scoping, plus the project's current scope. */
app.get("/api/projects/:id/branches", async (req, res) => {
  const p = projects.find((x) => x.id === req.params.id);
  if (!p) { res.status(404).json({ ok: false, error: "Project not found." }); return; }

  const root = await repoRootOf(p);
  if (!root) { res.json({ ok: true, git: false, branches: [], current: "", branch: "", baseBranch: "" }); return; }

  const { branches, current } = await gitBranches(root);
  res.json({ ok: true, git: true, branches, current, branch: p.branch ?? current, baseBranch: p.baseBranch ?? "" });
});

/**
 * Set what this project's agents are reviewing. Checking the branch out matters
 * as much as recording it: agents read files through the index, so reviewing a
 * diff while the working tree still holds another branch would have them reading
 * one version and reporting on another.
 */
app.post("/api/projects/:id/scope", async (req, res) => {
  const p = projects.find((x) => x.id === req.params.id);
  if (!p) { res.status(404).json({ ok: false, error: "Project not found." }); return; }

  const branch = String(req.body?.branch ?? "").trim();
  const baseBranch = String(req.body?.baseBranch ?? "").trim();

  const root = await repoRootOf(p);
  if (!root) { res.status(400).json({ ok: false, error: "This project is not a git checkout." }); return; }

  if (branch) {
    const { branches, current } = await gitBranches(root);
    if (!branches.includes(branch)) {
      res.status(400).json({ ok: false, error: `No branch named "${branch}" in this checkout.` });
      return;
    }
    if (branch !== current) {
      try {
        await execFileP("git", ["-C", root, "checkout", branch], { timeout: 60000, env: GIT_ENV });
      } catch (e: any) {
        const why = String(e?.stderr || e?.message || e).slice(0, 300);
        res.status(400).json({ ok: false, error: `Could not check out "${branch}": ${why}` });
        return;
      }
    }
  }

  if (branch && baseBranch && branch !== baseBranch) {
    if (!(await ensureMergeBase(root, baseBranch, branch))) {
      res.status(400).json({
        ok: false,
        error: `This checkout cannot work out where "${branch}" split off from "${baseBranch}", ` +
          `even after fetching more history. Reviewing the change would mean guessing which commits are yours, ` +
          `so the scope was not applied.`,
      });
      return;
    }
  }

  p.branch = branch || undefined;
  p.baseBranch = baseBranch || undefined;
  saveProjects();

  // Re-index: the files on disk just changed underneath the agents.
  if (workspaces.has(p.id)) {
    try { await reopenWorkspace(p.id); }
    catch (e) { console.error("[scope] reopen failed:", (e as Error).message); }
  }
  res.json({ ok: true, branch: p.branch ?? "", baseBranch: p.baseBranch ?? "" });
});

/** Change a project's Golden selection (works before and after creation). */
app.post("/api/projects/:id/golden", async (req, res) => {
  const p = projects.find((x) => x.id === req.params.id);
  if (!p) { res.status(404).json({ ok: false, error: "Project not found." }); return; }
  const b = req.body ?? {};
  const sel: ProjectGoldenSelection = {
    mode: b.mode === "subset" ? "subset" : "all",
    itemIds: Array.isArray(b.itemIds) ? b.itemIds.map(String) : [],
    tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
  };
  p.golden = sel;
  saveProjects();
  // The MCP server receives the resolved id list at spawn time, so re-activate to apply.
  if (workspaces.has(p.id)) {
    try { await reopenWorkspace(p.id); }
    catch (e) { console.error("[golden] reopen failed:", (e as Error).message); }
  }
  const selected = golden.selectedFor(sel, p.id);
  res.json({ ok: true, selection: sel, selectedCount: selected.length });
});

/**
 * The MCP server is handed the resolved selection at spawn. After a library change
 * the running server would be stale, so re-activate the current project to refresh it.
 */
/** Accepts a selection from project creation; defaults to "all" when omitted. */
function parseGoldenSelection(raw: any): ProjectGoldenSelection {
  if (!raw || raw.mode !== "subset") return { mode: "all" };
  return {
    mode: "subset",
    itemIds: Array.isArray(raw.itemIds) ? raw.itemIds.map(String) : [],
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
  };
}

let goldenRefreshTimer: NodeJS.Timeout | null = null;
function refreshGoldenForActiveProject() {
  if (!workspaces.size) return;
  if (goldenRefreshTimer) clearTimeout(goldenRefreshTimer);
  // debounce: bulk admin edits shouldn't respawn the server per item
  goldenRefreshTimer = setTimeout(() => {
    Promise.all([...workspaces.keys()].map((id) => reopenWorkspace(id))).catch((e) =>
      console.error("[golden] refresh failed:", (e as Error).message));
  }, 1500);
  goldenRefreshTimer.unref?.();
}

// ---- Projects API --------------------------------------------------------
app.get("/api/projects", (req, res) => {
  const { state } = sessionOf(req, res);
  res.json({ activeProjectId: state.projectId, projects: projects.map(publicProject) });
});

// A "local folder" is a folder on the machine running ASTRA. When ASTRA is hosted,
// that is the container — not the user's laptop — and pasting C:\... silently
// resolved against the cwd ("/app/ui/C:\Sandbox"). Fail with an explanation instead.
function resolveLocalFolder(input: string): string {
  const raw = String(input).trim().replace(/^["']|["']$/g, "");
  const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\");
  if (isWindowsPath && path.sep === "/") {
    throw new Error(
      `"${raw}" is a Windows path, but ASTRA is running on Linux${IS_CLOUD ? " in the cloud" : ""}. ` +
        `A local folder must exist on the machine running ASTRA — it cannot reach your own PC. ` +
        `Use the "Git repository" tab instead, or run ASTRA locally (Docker) with that folder mounted.`
    );
  }
  if (!path.isAbsolute(raw)) throw new Error(`Enter an absolute folder path (got "${raw}").`);
  if (!fs.existsSync(raw)) throw new Error(`Folder not found on the ASTRA server: ${raw}`);
  if (!fs.statSync(raw).isDirectory()) throw new Error(`Not a folder: ${raw}`);
  return raw;
}

// Never let a token reach disk, the UI, or the logs.
function scrubUrl(url: string): string {
  return url.replace(/\/\/[^/@\s]+@/, "//");
}
// GitHub/GitLab accept "x-access-token:<pat>"; Azure DevOps ignores the username
// and uses the password. A token containing ":" is treated as "user:secret".
function withCredentials(url: string, token?: string): string {
  if (!token) return url;
  if (!/^https?:\/\//i.test(url)) return url; // ssh:// and git@ use keys, not tokens
  const i = token.indexOf(":");
  const [user, secret] = i === -1 ? ["x-access-token", token] : [token.slice(0, i), token.slice(i + 1)];
  return url.replace(/^(https?:\/\/)/i, `$1${encodeURIComponent(user)}:${encodeURIComponent(secret)}@`);
}

function gitCloneHelp(stderr: string, url: string, hadToken: boolean): string {
  const s = stderr.toLowerCase();
  if (s.includes("could not read username") || s.includes("authentication failed") ||
      s.includes("terminal prompts disabled") || s.includes("repository not found") ||
      s.includes("403") || s.includes("invalid username or password")) {
    return hadToken
      ? `Authentication was rejected for ${scrubUrl(url)}. Check the token is valid, unexpired, and has read access to this repository (GitHub fine-grained tokens also need the org to approve them).`
      : `${scrubUrl(url)} needs authentication — it is private, or the URL is wrong (git cannot tell those apart). ` +
        `Add an access token in the "Access token" field, or use a public repository URL.`;
  }
  if (s.includes("could not resolve host") || s.includes("failed to connect") || s.includes("timed out"))
    return `Cannot reach ${scrubUrl(url)} from the ASTRA server — check the URL, and that outbound access to that host is allowed.`;
  if (s.includes("not found") && s.includes("branch"))
    return `That branch does not exist in ${scrubUrl(url)}.`;
  return `git clone failed: ${stderr.slice(0, 300)}`;
}

// ---- Upload a codebase as a .zip ------------------------------------------
// Hosted users have no access to the server's filesystem, so "local folder" is
// useless to them and not every codebase is in a reachable git remote. A zip
// upload is the third way in.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 300);

// Stream the request body to disk (never buffer a 300 MB zip in memory) and stop
// the moment it exceeds the cap.
function receiveUpload(req: express.Request, dest: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const limit = MAX_UPLOAD_MB * 1024 * 1024;
    let size = 0;
    const out = fs.createWriteStream(dest);
    let aborted = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit && !aborted) {
        aborted = true;
        // Unpipe and drain rather than destroy() — killing the socket here would
        // leave the browser with "connection dropped" instead of the real reason.
        req.unpipe(out);
        req.resume();
        out.destroy();
        reject(new Error(`Upload is larger than the ${MAX_UPLOAD_MB} MB limit.`));
      }
    });
    req.on("error", reject);
    out.on("error", reject);
    out.on("finish", () => resolve(size));
    req.pipe(out);
  });
}

function assertLooksLikeZip(file: string) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(4);
  try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
  if (head[0] === 0x50 && head[1] === 0x4b) return;                     // "PK"
  if (head[0] === 0x1f && head[1] === 0x8b)                             // gzip
    throw new Error("That looks like a .tar.gz. Please upload a .zip file.");
  if (head.subarray(0, 4).toString() === "Rar!" || head[0] === 0x37)
    throw new Error("That looks like a .rar/.7z. Please upload a .zip file.");
  throw new Error("That file is not a .zip archive.");
}

// Symlinks are the way a crafted zip escapes its directory, so drop them all;
// then prove every remaining path really is inside dir.
function hardenExtracted(dir: string) {
  const root = fs.realpathSync(dir);
  let removed = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      // Links are the entire attack: a symlink or junction is what points outside the
      // extraction root. Deleting them before descending means no directory we walk
      // into can be one, which is what makes the check below unnecessary.
      if (e.isSymbolicLink()) { fs.rmSync(full, { force: true }); removed++; continue; }
      if (e.isDirectory()) walk(full);
      // A regular file reached through a chain of real directories resolves to itself,
      // so its realpath cannot escape the root. This used to call realpathSync on every
      // one — a syscall per file, on files that were about to be deleted as build
      // output anyway, for a comparison that could never fail.
    }
  };
  walk(root);
  return removed;
}

// GitHub "Download ZIP" and Windows "Send to → Compressed folder" both wrap the
// code in a single top-level folder. Descend into it so "src" means what the user thinks.
function collapseSingleRoot(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith("__MACOSX"));
  if (entries.length === 1 && entries[0].isDirectory()) return path.join(dir, entries[0].name);
  return dir;
}

app.post("/api/projects/upload", async (req, res) => {
  const name = String(req.query.name || "").trim();
  const subPath = String(req.query.subPath || "").trim();
  const alive = keepJsonAlive(res); // extraction + indexing runs long and silent
  const dir = path.join(WORKSPACE_DIR, "upload-tmp-" + crypto.randomUUID().slice(0, 8));
  const zipFile = dir + ".zip";
  let extracted: string | null = null;
  try {
    if (!name) throw new Error("A project name is required.");
    // Reject on the declared size before reading a single byte — far better than
    // making someone wait out a 400 MB upload only to be told it was too big.
    const declared = Number(req.headers["content-length"] || 0);
    if (declared && declared > MAX_UPLOAD_MB * 1024 * 1024)
      throw new Error(
        `That zip is ${(declared / 1048576).toFixed(0)} MB — the limit is ${MAX_UPLOAD_MB} MB. ` +
          `Zip only the source folders (exclude bin/obj/packages), or raise MAX_UPLOAD_MB on the server.`
      );
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    // Upload is the slowest thing the app does and the least visible, so each phase
    // reports what it cost. Without this, "the upload is slow" is unanswerable.
    const t: Record<string, number> = {};
    let mark = Date.now();
    const phase = (n: string) => { t[n] = Date.now() - mark; mark = Date.now(); };

    const bytes = await receiveUpload(req, zipFile);
    if (!bytes) throw new Error("The upload was empty.");
    assertLooksLikeZip(zipFile);
    phase("receive");

    fs.mkdirSync(dir, { recursive: true });
    extracted = dir;
    let unzipError: any = null;
    try {
      // -qq quiet, -o overwrite; unzip refuses absolute paths itself. The -x patterns
      // keep build output off the disk in the first place; pruneUnindexed below is what
      // guarantees it, so a pattern that misses costs space rather than correctness.
      await execFileP("unzip", ["-qq", "-o", zipFile, "-d", dir, ...unzipExcludeArgs()],
        { timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
    } catch (e: any) {
      if (e?.code === "ENOENT")
        throw new Error(
          "unzip is not available on this server, so .zip projects cannot be extracted here. " +
          "Add the project from its git URL instead, or — running locally — use the Local folder option."
        );
      // Every exclusion that matches nothing is a "caution", and unzip exits non-zero
      // for it. No real zip contains all thirteen ignored folders, so treating that as
      // failure would reject virtually every upload. Judge by what landed on disk.
      unzipError = e;
    }
    phase("unzip");
    // Prune first: whatever the exclusions missed is deleted here, so hardening walks
    // only the files being kept rather than the ones on their way to the bin.
    const pruned = pruneUnindexed(dir);
    phase("prune");
    hardenExtracted(dir);
    phase("harden");

    const kept = countFiles(dir);
    phase("count");
    if (!kept) {
      throw new Error(
        unzipError
          ? `Could not extract the zip: ${String(unzipError?.stderr || unzipError?.message || unzipError).slice(0, 200)}`
          : "That zip contained no source — only build output (bin, obj, packages, node_modules…)."
      );
    }

    const id = newId(name);
    const finalDir = path.join(WORKSPACE_DIR, id);
    fs.renameSync(collapseSingleRoot(dir), finalDir);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(zipFile, { force: true });
    extracted = finalDir;

    const sourceRoot = subPath ? path.join(finalDir, subPath) : finalDir;
    if (!fs.existsSync(sourceRoot))
      throw new Error(`The sub-folder "${subPath}" does not exist in the uploaded zip. Leave it blank to index everything.`);

    const project: Project = {
      id, name, type: "upload", sourceRoot,
      subPath: subPath || undefined,
      artifactsDir: path.join(ARTIFACTS_ROOT, id),
      createdAt: new Date().toISOString(),
    };
    projects.push(project);
    saveProjects();
    phase("move");
    await activateProject(id);
    phase("index");
    extracted = null; // committed

    console.error(
      `[upload] ${name}: ${(bytes / 1048576).toFixed(1)}MB, ${kept} files kept, ` +
      `${pruned.removed} folders pruned — ` +
      Object.entries(t).map(([k, ms]) => `${k} ${(ms / 1000).toFixed(1)}s`).join(", ")
    );
    recordDiag("uploads", {
      project: id,
      megabytes: Number((bytes / 1048576).toFixed(1)),
      filesKept: kept,
      foldersPruned: pruned.removed,
      prunedMb: Number((pruned.bytes / 1048576).toFixed(1)),
      totalSec: Number((Object.values(t).reduce((a, b) => a + b, 0) / 1000).toFixed(1)),
      phasesSec: Object.fromEntries(Object.entries(t).map(([k, ms]) => [k, Number((ms / 1000).toFixed(1))])),
    });
    // Report what was dropped. The next zip is smaller only if someone learns that
    // most of the last one never needed to be sent.
    alive.send(200, {
      ok: true, project: publicProject(project), sizeBytes: bytes,
      excluded: pruned.removed
        ? { folders: pruned.removed, bytes: pruned.bytes, kinds: NEVER_INDEXED.slice(0, 6) }
        : undefined,
    });
  } catch (e) {
    try { fs.rmSync(zipFile, { force: true }); } catch {}
    if (extracted) { try { fs.rmSync(extracted, { recursive: true, force: true }); } catch {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    alive.send(400, { ok: false, error: (e as Error).message });
  }
});

// Create a project from a local folder or a git repo, then activate it.
app.post("/api/projects", async (req, res) => {
  const { name, type, path: localPath, repoUrl, subPath, token } = req.body ?? {};
  // A clone that succeeds but fails a later check (bad sub-folder, index error) must
  // not leave a full checkout stranded on disk.
  let clonedDir: string | null = null;
  const alive = keepJsonAlive(res); // cloning + indexing a large repo runs long and silent
  try {
    if (!name || !type) throw new Error("name and type are required");
    const id = newId(name);
    let sourceRoot: string;
    let repoUrlOut: string | undefined;

    if (type === "local") {
      if (!localPath) throw new Error("A folder path is required for a local project.");
      const abs = resolveLocalFolder(String(localPath));
      sourceRoot = subPath ? path.join(abs, String(subPath)) : abs;
    } else if (type === "git") {
      if (!repoUrl) throw new Error("A repository URL is required for a git project.");
      const cleanUrl = scrubUrl(String(repoUrl).trim());
      const pat = token ? String(token).trim() : "";
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      const dir = path.join(WORKSPACE_DIR, id);
      try {
        // Deep enough to answer "what changed on my branch", cheap enough not to
        // pay for a decade of history. `--depth 1 --single-branch` (the default
        // pairing) leaves git_diff/git_log with one commit and one branch, so every
        // range an agent might ask for fails to resolve.
        await execFileP("git", ["clone", "--depth", "50", "--no-single-branch", withCredentials(cleanUrl, pat), dir], {
          timeout: 300000,
          // Without this git blocks on a hidden credential prompt and dies with the
          // cryptic "could not read Username … No such device or address".
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
        });
      } catch (e: any) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        if (e?.code === "ENOENT") throw new Error("git is not installed or not on PATH.");
        const stderr = scrubUrl(String(e?.stderr || e?.message || e));
        throw new Error(gitCloneHelp(stderr, cleanUrl, !!pat));
      }
      clonedDir = dir;
      // The token would otherwise sit in .git/config on disk for anyone to read.
      if (pat) {
        try { await execFileP("git", ["-C", dir, "remote", "set-url", "origin", cleanUrl]); } catch {}
      }
      sourceRoot = subPath ? path.join(dir, String(subPath)) : dir;
      repoUrlOut = cleanUrl; // stored without credentials
    } else if (type === "documents") {
      // Nothing to clone or index: an empty folder the MCP server can sit on while the
      // project's real content arrives as input documents.
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      sourceRoot = path.join(WORKSPACE_DIR, id);
      fs.mkdirSync(sourceRoot, { recursive: true });
    } else {
      throw new Error(`Unknown project type: ${type}`);
    }

    if (!fs.existsSync(sourceRoot)) {
      // Nearly always a wrong "sub-folder to index" — say so rather than echoing a path.
      throw new Error(
        subPath
          ? `The sub-folder "${subPath}" does not exist in this ${type === "git" ? "repository" : "folder"}. Leave it blank to index everything.`
          : `Source root not found after setup: ${sourceRoot}`
      );
    }

    const project: Project = {
      id,
      name: String(name),
      type,
      sourceRoot,
      repoUrl: repoUrlOut,
      subPath: subPath ? String(subPath) : undefined,
      artifactsDir: path.join(ARTIFACTS_ROOT, id),
      createdAt: new Date().toISOString(),
      golden: parseGoldenSelection(req.body?.golden),
    };
    projects.push(project);
    saveProjects();
    await activateProject(id); // spawn MCP + index now
    clonedDir = null; // committed — keep the checkout
    alive.send(200, { ok: true, project: publicProject(project) });
  } catch (e) {
    if (clonedDir) { try { fs.rmSync(clonedDir, { recursive: true, force: true }); } catch {} }
    alive.send(400, { ok: false, error: (e as Error).message });
  }
});

app.post("/api/projects/:id/activate", async (req, res) => {
  const alive = keepJsonAlive(res); // re-indexing a large codebase runs long and silent
  try {
    await activateProject(req.params.id);
    sessionOf(req, res).state.projectId = req.params.id;   // this browser follows the switch
    const p = projects.find((x) => x.id === req.params.id);
    alive.send(200, { ok: true, project: p ? publicProject(p) : null });
  } catch (e) {
    alive.send(400, { ok: false, error: (e as Error).message });
  }
});

app.delete("/api/projects/:id", async (req, res) => {
  const id = req.params.id;
  if (id === DEMO_ID) {
    res.status(400).json({ ok: false, error: "The demo project can't be removed." });
    return;
  }
  const p = projects.find((x) => x.id === id);
  if (!p) {
    res.status(404).json({ ok: false, error: "Project not found." });
    return;
  }
  projects = projects.filter((x) => x.id !== id);
  saveProjects();
  if (p.type === "git" || p.type === "documents") {
    try { fs.rmSync(path.join(WORKSPACE_DIR, id), { recursive: true, force: true }); } catch {}
  }
  // Uploaded input documents are someone's source material, often a client's — they go
  // with the project. (Generated artifacts stay, as they always have.)
  try { fs.rmSync(inputsDirOf(p), { recursive: true, force: true }); } catch {}
  // Library items scoped to this project would otherwise sit there unreachable.
  for (const i of golden.list({ includeArchived: false }).filter((x) => x.scope === id)) {
    try { await golden.archive(i.id); } catch {}
  }
  { const ws = workspaces.get(id); if (ws) await closeWorkspace(ws); }

  // Move anyone standing on the deleted project, and the default with them.
  const next = fallbackProjectId(id);
  for (const st of sessions.values()) if (st.projectId === id) st.projectId = next ?? DEMO_ID;
  if (defaultProjectId === id) {
    defaultProjectId = next ?? DEMO_ID;
    saveProjects();
    // Started, not awaited: deleting one project should not block on indexing another,
    // which can take ten minutes on a large repository.
    if (next) openWorkspace(next);
  }
  res.json({ ok: true });
});

// ---- Input documents (per project) ---------------------------------------
//
// Source material for a project that has no code — requirement documents, briefs, a
// client's prompt — or an extra input for one that does. Stored as Markdown under the
// project's artifacts folder, which is exactly where agents already look for prior
// deliverables, so `list_artifacts` / `read_artifact` open them with no new tool. They
// belong to the project alone: nothing here is published to the shared Golden library.
//
// Why not the code index? It reads only code and config; a .md or .txt file is ignored,
// so a documents-only project showed an agent zero readable files.
const INPUT_EXT = new Set([".md", ".markdown", ".txt", ".docx", ".pdf"]);

function inputsDirOf(p: Project): string { return path.join(p.artifactsDir, "inputs"); }

/** Always a plain `<name>.md` inside the inputs folder, whatever the upload was called. */
function safeInputName(filename: string): string {
  const base = path.basename(String(filename || "document")).replace(/\.[^.]+$/, "");
  const clean = base.replace(/[^A-Za-z0-9 ._()-]+/g, "-").replace(/\s+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
  return `${clean || "document"}.md`;
}

async function readRaw(req: express.Request, limitMb: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared && declared > limitMb * 1024 * 1024)
    throw new Error(`That file is ${(declared / 1048576).toFixed(1)} MB — the limit is ${limitMb} MB.`);
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitMb * 1024 * 1024) { req.pause(); req.resume(); reject(new Error(`That file is larger than the ${limitMb} MB limit.`)); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve());
    req.on("error", reject);
  });
  return Buffer.concat(chunks);
}

app.get("/api/projects/:id/inputs", (req, res) => {
  const p = projects.find((x) => x.id === req.params.id);
  if (!p) { res.status(404).json({ ok: false, error: "Project not found." }); return; }
  res.json({ ok: true, files: walkFiles(inputsDirOf(p), p.artifactsDir).sort((a, b) => a.path.localeCompare(b.path)) });
});

app.post("/api/projects/:id/inputs", async (req, res) => {
  try {
    const p = projects.find((x) => x.id === req.params.id);
    if (!p) { res.status(404).json({ ok: false, error: "Project not found." }); return; }
    const filename = String(req.query.filename || "document").trim();
    const ext = path.extname(filename).toLowerCase();
    if (!INPUT_EXT.has(ext))
      throw new Error(`"${filename}" is not a supported input. Use a Word (.docx), PDF, Markdown or text file.`);

    const buf = await readRaw(req, MAX_DOC_MB);
    if (!buf.length) throw new Error("The upload was empty.");

    let markdown: string;
    let warnings: string[] = [];
    if (ext === ".docx" || ext === ".pdf") {
      const out = await convertDocument(buf, filename, { stripLinkUrls: req.query.keepLinks !== "1" });
      markdown = out.markdown; warnings = out.warnings;
    } else {
      markdown = buf.toString("utf8").replace(/^﻿/, "");
      for (const hit of scanForInjection(markdown))
        warnings.push(`SECURITY — this text reads as an instruction to an AI, not as source material: ${hit}. Agents read it as data, never as commands.`);
    }
    if (!markdown.trim()) throw new Error("No text could be read from that file.");

    const name = safeInputName(filename);
    fs.mkdirSync(inputsDirOf(p), { recursive: true });
    fs.writeFileSync(path.join(inputsDirOf(p), name), markdown);
    console.error(`[inputs] ${p.id}: ${name} — ${markdown.length} chars, ${warnings.length} warning(s)`);
    res.json({ ok: true, file: `inputs/${name}`, chars: markdown.length, warnings });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

app.delete("/api/projects/:id/inputs", (req, res) => {
  const p = projects.find((x) => x.id === req.params.id);
  if (!p) { res.status(404).json({ ok: false, error: "Project not found." }); return; }
  const file = path.join(inputsDirOf(p), path.basename(String(req.query.file || "")));
  if (!fs.existsSync(file)) { res.status(404).json({ ok: false, error: "No such input document." }); return; }
  fs.rmSync(file, { force: true });
  res.json({ ok: true });
});

// ---- Artifacts API (per active project) ----------------------------------
function walkFiles(dir: string, base = dir): { path: string; size: number; mtime: number }[] {
  if (!fs.existsSync(dir)) return [];
  const out: { path: string; size: number; mtime: number }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // skip .gitkeep etc.
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else {
      const st = fs.statSync(full);
      out.push({ path: path.relative(base, full).split(path.sep).join("/"), size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}
function safeArtifactPath(rel: string, project: Project | null): string {
  const dir = project?.artifactsDir;
  if (!dir) throw new Error("No project loaded.");
  const root = path.resolve(dir);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("Invalid path");
  return abs;
}

app.get("/api/artifacts", (req, res) => {
  const { state } = sessionOf(req, res);
  const p = projects.find((x) => x.id === state.projectId);
  const files = p ? walkFiles(p.artifactsDir).sort((a, b) => b.mtime - a.mtime) : [];
  res.json({ projectId: p?.id, files });
});

app.get("/api/artifacts/content", (req, res) => {
  try {
    const { state } = sessionOf(req, res);
    const abs = safeArtifactPath(String(req.query.path || ""), projects.find((x) => x.id === state.projectId) ?? null);
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, path: req.query.path, content: fs.readFileSync(abs, "utf8") });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

app.get("/api/artifacts/download", (req, res) => {
  try {
    const { state } = sessionOf(req, res);
    const abs = safeArtifactPath(String(req.query.path || ""), projects.find((x) => x.id === state.projectId) ?? null);
    if (!fs.existsSync(abs)) return res.status(404).send("Not found");
    res.download(abs, path.basename(abs));
  } catch (e) {
    res.status(400).send((e as Error).message);
  }
});

// Diagnostics / offline-friendly: run a single MCP tool directly (no LLM).
app.post("/api/tool", async (req, res) => {
  const { ws } = await runContextOf(req, res);
  if (!ws.ready) {
    res.status(503).json({ ok: false, error: ws.error ?? "MCP server still starting…" });
    return;
  }
  const { name, arguments: args } = req.body ?? {};
  try {
    const text = await callMcpTool(ws, name, args ?? {});
    res.json({ ok: true, result: text });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// Streaming chat: NDJSON events (tool_call / tool_result / text / done / error).
app.post("/api/chat", async (req, res) => {
  const { agentId, message } = req.body ?? {};
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    res.status(404).json({ error: `Unknown agent: ${agentId}` });
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no"); // don't let a proxy buffer the stream
  const emit = (e: any) => res.write(JSON.stringify(e) + "\n");

  // Azure App Service drops any connection idle for 230s, and a single slow step
  // (a big index scan, a long model turn) can easily be silent for longer than
  // that — which surfaces to the user as a network timeout mid-answer. A periodic
  // ping keeps bytes flowing; the client ignores event types it doesn't know.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) emit({ type: "ping", at: Date.now() });
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  res.on("close", () => clearInterval(heartbeat));

  const run = await runContextOf(req, res);
  if (!run.ws.ready) {
    emit({ type: "error", message: run.ws.error ?? "MCP server is still starting — try again in a moment." });
    res.end();
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    emit({
      type: "error",
      message:
        "ANTHROPIC_API_KEY is not set. Set it and restart the server to run the live agents (the MCP tools still work via /api/tool).",
    });
    res.end();
    return;
  }

  // Resume an existing thread (memory) or start a new one.
  const projectId = run.project?.id ?? "none";
  let thread = threads.find((t) => t.id === req.body?.threadId && t.projectId === projectId);
  if (!thread) {
    thread = {
      id: `${agent.id}-${crypto.randomBytes(4).toString("hex")}`,
      projectId, agentId: agent.id, agentName: agent.name,
      title: String(message).slice(0, 70),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      messages: [],
    };
    threads.push(thread);
  }

  try {
    emit({ type: "start", agent: agent.name, model: MODEL });
    emit({ type: "thread", id: thread.id, title: thread.title });

    // Resolved before any analysis, so a finding is tied to a commit rather than to
    // whatever happened to be checked out by the time it was written.
    currentRun = await runIdentity(run.project, agent.name, run.ws.tools.length);
    emit({ type: "identity", identity: currentRun });

    // Replay the last N turns so follow-up questions have context.
    const prior: Anthropic.MessageParam[] = thread.messages
      .slice(-MEMORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.text }));

    const runStarted = Date.now();
    let answer = await runAgent(run, agent, message, emit, 0, prior);
    // Cut-off is the thing worth counting: an agent that runs out of steps returns a
    // partial answer that reads like a whole one unless you notice the warning.
    recordDiag("runs", {
      agent: agent.id,
      project: run.project?.id ?? "",
      seconds: Number(((Date.now() - runStarted) / 1000).toFixed(1)),
      cutOff: answer.includes("Analysis was cut off at the"),
      stepLimit: MAX_TURNS,
      chars: answer.length,
    });

    // Last line of the answer, so it travels with a copy-pasted response the way the
    // footer travels with a saved artifact.
    if (currentRun) {
      const footer = identityFooter(currentRun);
      emit({ type: "text_delta", text: footer });
      answer += footer;
    }

    const now = new Date().toISOString();
    thread.messages.push({ role: "user", text: String(message), at: now });
    thread.messages.push({ role: "assistant", text: answer, at: now });
    thread.updatedAt = now;
    saveThreads();
    emit({ type: "done" });
  } catch (e) {
    emit({ type: "error", message: (e as Error).message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// ---- Threads API (conversation history) ----------------------------------
app.get("/api/threads", (req, res) => {
  const projectId = sessionOf(req, res).state.projectId;
  const agentId = req.query.agentId ? String(req.query.agentId) : null;
  const list = threads
    .filter((t) => t.projectId === projectId && (!agentId || t.agentId === agentId))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map(threadSummary);
  res.json({ threads: list });
});

app.get("/api/threads/:id", (req, res) => {
  const t = threads.find((x) => x.id === req.params.id);
  if (!t) { res.status(404).json({ ok: false, error: "Thread not found" }); return; }
  res.json({ ok: true, thread: t });
});

app.delete("/api/threads/:id", (req, res) => {
  const before = threads.length;
  threads = threads.filter((t) => t.id !== req.params.id);
  saveThreads();
  res.json({ ok: true, removed: before - threads.length });
});

// ---------------------------------------------------------------------------
function main() {
  for (const d of [STATE_DIR, ARTIFACTS_ROOT, WORKSPACE_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
  agents = loadAgents();
  loadSettings();   // before anything reads MODEL or makes a call
  loadProjects();
  loadThreads();
  console.error(
    `[ui] ${agents.length} agents, ${projects.length} projects; active=${defaultProjectId}`
  );

  // Listen immediately so the page loads instantly; connect MCP in the background.
  const server = app.listen(PORT, () => {
    console.error(`\n  ASTRA AgenticOS →  http://localhost:${PORT}\n`);
    if (!process.env.ANTHROPIC_API_KEY)
      console.error("  ⚠  ANTHROPIC_API_KEY not set — set it for the live agents.\n");
  });
  // Node aborts a request whose body takes longer than requestTimeout (default 5 min)
  // to arrive — a 300 MB upload over a slow corporate link exceeds that. Agent runs and
  // indexing are unaffected by these, but a long-lived response needs no socket timeout.
  server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS ?? 30 * 60 * 1000);
  server.headersTimeout = server.requestTimeout + 5000;
  server.timeout = 0; // no socket-inactivity cap; the heartbeats keep proxies happy

  if (defaultProjectId) {
    workspaceFor(defaultProjectId).catch((e) =>
      console.error("[mcp] connect failed:", (e as Error).message)
    );
  } else {
    console.error("[mcp] " + (IS_CLOUD
      ? "No project loaded yet — add one to begin: upload a .zip of your code, or point ASTRA at a git repository."
      : "No project loaded yet — add a project (local folder, git repo or .zip upload) to begin."));
  }
}

main();
