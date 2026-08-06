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
import { NEVER_INDEXED, unzipExcludeArgs, pruneUnindexed, countFiles } from "./workspace.js";
import {
  unprovenClaims,
  unsavedArtifactClaims,
  unqualifiedCompatibility,
  prerequisiteGate,
  requiredInputs,
  stampable,
} from "./verify.js";
import { convertDocument } from "./doc-convert.js";
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
  type: "local" | "git" | "upload";
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
      GOLDEN_ITEMS: golden.selectedFor(project.golden).map((i) => i.id).join(","),
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

This platform indexes C#, Java, and TypeScript/JavaScript (including Angular and React).
Before applying any language- or framework-specific convention:

- **Detect the stack from the real files** — file extensions and the manifests
  (\`*.csproj\`/\`*.sln\`, \`pom.xml\`/\`build.gradle\`, \`package.json\`/\`angular.json\`/\`tsconfig.json\`).
  Use \`solution_overview\` and \`search_code\` to confirm; don't assume .NET/C#.
- **Use the conventions that project actually uses** — its language and version, build tool
  (MSBuild / Maven / Gradle / npm / pnpm), test framework (xUnit/NUnit/MSTest, JUnit, Jest/Vitest,
  Cypress/Playwright), DI style, and folder layout. Examples in a persona that name .NET/nopCommerce
  specifics are illustrative — translate them to the stack in front of you.
- **Name idioms correctly per stack** — e.g. Spring \`@Service\`/\`@RestController\`/JPA repositories for
  Java; components/services/modules/RxJS for Angular; components/hooks/props for React.
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
   did not check those, say which you did not.`;


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
    const selected = golden.selectedFor(project?.golden);
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
    .selectedFor(project?.golden)
    .filter((i) => i.kind === "template" && i.status === "published" && i.appliesTo.includes(agentId));
}

/**
 * Phase 3 enforcement. Returns an error string to hand back instead of running the
 * tool, or null to allow it. We gate the act of *delivering* (save_artifact), not
 * thinking — the agent may explore freely, but it cannot produce the deliverable
 * until it has actually read the template that governs it.
 */
function templateGate(agentId: string, toolName: string, readSoFar: Set<string>, project: Project | null): string | null {
  if (toolName !== "save_artifact") return null;
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
    for (let attempt = 0; ; attempt++) {
      let emittedThisAttempt = 0;
      let attemptText = "";
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
        resp = await stream.finalMessage();
        outText += attemptText; // commit only once the turn actually succeeded
        break;
      } catch (e) {
        if (attempt < 3 && isRetryable(e)) {
          console.error(`[agent] transient error, retry ${attempt + 1}:`, (e as Error).message);
          if (emittedThisAttempt > 0) emit({ type: "text_reset" });
          emit({ type: "notice", message: "Reconnecting to the model…" });
          await sleep(600 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    if (!resp) break;
    lastStop = resp.stop_reason;

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
    if (resp.stop_reason !== "tool_use") break;

    // Execute tools / delegations and stream results back as each completes.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
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
      } else {
        // Phase 3 — hard template binding. A template that names THIS agent must be
        // read before the agent is allowed to save a deliverable. Enforced here rather
        // than asked for in the prompt, so it can't be skipped.
        const gate =
          templateGate(agent.id, tu.name, goldenReadThisRun, project) ??
          prerequisiteGate(tu.name, required, readOk, failedArtifactReads);
        if (gate) {
          resultText = gate;
          emit({ type: "tool_result", id: tu.id, name: tu.name, result: resultText });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: resultText, is_error: true });
          continue;
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
          resultText = await callMcpTool(ws, tu.name, args);
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
              readOk.add(asked);
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
  const cited = [...new Set(
    [...outText.matchAll(/\b(GLD-[A-Z]+-\d+)@\d+/g)].map((m) => m[1].toUpperCase())
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

  // Same idea as the citation check, applied to claims about the running world.
  // Static tools cannot see a deployment or a test result, so these sentences are
  // describing something this run did not observe — whatever their wording implies.
  const overreach = unprovenClaims(outText);
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
  const vague = unqualifiedCompatibility(outText);
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
  const phantom = unsavedArtifactClaims(outText, savedThisRun);
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
    limits: { stepLimit: MAX_TURNS, toolTimeoutMs: MCP_TIMEOUT_MS, maxWorkspaces: MAX_WORKSPACES, maxUploadMb: MAX_UPLOAD_MB },
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

app.post("/api/golden", async (req, res) => {
  try {
    const b = req.body ?? {};
    const item = await golden.create({
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
  const selected = golden.selectedFor(p?.golden);
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
  const selected = golden.selectedFor(sel);
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
  if (p.type === "git") {
    try { fs.rmSync(path.join(WORKSPACE_DIR, id), { recursive: true, force: true }); } catch {}
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
