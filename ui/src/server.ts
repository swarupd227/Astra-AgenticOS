import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import matter from "gray-matter";
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
const MODEL = process.env.MODEL ?? "claude-sonnet-4-6";
// Large enough that document-generating agents (BRD, big test files) don't get
// truncated mid-tool-argument. Configurable via env.
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 16000);

const DLL = path.join(
  repoRoot,
  "src/SdlcAgents.Mcp/bin/Release/net9.0/SdlcAgents.Mcp.dll"
);
const AGENTS_DIR = path.join(repoRoot, ".github/agents");
const ARTIFACTS_ROOT = path.join(repoRoot, "artifacts");
const WORKSPACE_DIR = path.join(repoRoot, "workspace"); // cloned git repos live here
const PROJECTS_FILE = path.join(__dirname, "..", "projects.json");

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
  type: "local" | "git";
  sourceRoot: string; // absolute path the MCP server indexes
  repoUrl?: string;
  subPath?: string;
  artifactsDir: string;
  createdAt: string;
}
let projects: Project[] = [];
let activeProjectId: string | null = null;

const DEMO_ID = "nopcommerce";
function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
}
function newId(name: string) {
  return `${slug(name)}-${crypto.randomBytes(3).toString("hex")}`;
}
function activeProject(): Project | undefined {
  return projects.find((p) => p.id === activeProjectId);
}
function demoProject(): Project {
  return {
    id: DEMO_ID,
    name: "nopCommerce 3.90 (demo)",
    type: "local",
    sourceRoot: path.join(repoRoot, "demo/nopCommerce/src"),
    artifactsDir: ARTIFACTS_ROOT,
    createdAt: new Date().toISOString(),
  };
}
function loadProjects() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
    projects = Array.isArray(raw.projects) ? raw.projects : [];
    activeProjectId = raw.activeProjectId ?? null;
  } catch {
    projects = [];
  }
  if (!projects.some((p) => p.id === DEMO_ID)) projects.unshift(demoProject());
  if (!activeProjectId || !projects.some((p) => p.id === activeProjectId)) activeProjectId = DEMO_ID;
}
function saveProjects() {
  try {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify({ activeProjectId, projects }, null, 2));
  } catch (e) {
    console.error("[projects] save failed:", (e as Error).message);
  }
}
function publicProject(p: Project) {
  return { id: p.id, name: p.name, type: p.type, sourceRoot: p.sourceRoot, repoUrl: p.repoUrl, createdAt: p.createdAt };
}

// ---------------------------------------------------------------------------
// MCP client — launches the SAME C# server VS Code uses, over stdio, pointed at
// the active project's source root. Switching projects re-spawns it.
// ---------------------------------------------------------------------------
let mcp: Client | undefined;
let mcpTools: Anthropic.Tool[] = [];
let mcpReady = false;
let mcpError: string | null = null;

async function connectMcp(project: Project) {
  if (!fs.existsSync(DLL)) {
    throw new Error(`MCP server DLL not found at ${DLL}. Run ./scripts/setup.ps1 (builds Release) first.`);
  }
  if (!fs.existsSync(project.sourceRoot)) {
    throw new Error(`Source root not found: ${project.sourceRoot}`);
  }
  // Tear down any previous server (kills its child dotnet process).
  if (mcp) {
    try { await mcp.close(); } catch {}
    mcp = undefined;
  }
  mcpReady = false;
  mcpError = null;
  mcpTools = [];
  fs.mkdirSync(project.artifactsDir, { recursive: true });

  const transport = new StdioClientTransport({
    command: "dotnet",
    args: [DLL],
    env: {
      ...(process.env as Record<string, string>),
      NOPCOMMERCE_ROOT: project.sourceRoot, // the C# server indexes this root
      ARTIFACTS_DIR: project.artifactsDir,
    },
  });
  const client = new Client({ name: "astra-agenticos-ui", version: "2.0.0" });
  await client.connect(transport);
  mcp = client;

  const listed = await client.listTools();
  mcpTools = listed.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  console.error(`[mcp] connected to "${project.name}" (${project.sourceRoot}) — ${mcpTools.length} tools`);
  mcpReady = true;

  // Warm the Roslyn index so the first real prompt is snappy.
  try {
    await client.callTool({ name: "solution_overview", arguments: {} });
    console.error("[mcp] index warmed.");
  } catch (e) {
    console.error("[mcp] warmup skipped:", (e as Error).message);
  }
}

async function activateProject(id: string) {
  const p = projects.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown project: ${id}`);
  activeProjectId = id;
  saveProjects();
  await connectMcp(p);
}

async function callMcpTool(name: string, args: Record<string, unknown>) {
  if (!mcp) throw new Error("No active project / MCP server not connected.");
  const res: any = await mcp.callTool({ name, arguments: args });
  const text = (res.content ?? [])
    .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
    .join("\n");
  return text || "(no output)";
}

// ---------------------------------------------------------------------------
// Agentic loop — Claude picks tools, MCP executes, events stream to the UI
// ---------------------------------------------------------------------------
const anthropic = new Anthropic({ maxRetries: 4 }); // reads ANTHROPIC_API_KEY

// Deep agents (threat model, code-gen, orchestrator) need many tool-call turns
// before they synthesise. Too low a cap truncates them mid-analysis. Configurable.
const MAX_TURNS = Number(process.env.MAX_TURNS_PER_RUN ?? 36);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Transient API failures worth retrying (connection drops, overload, 5xx).
function isRetryable(e: any): boolean {
  if (e instanceof Anthropic.APIConnectionError) return true;
  const s = e?.status;
  if (s === 408 || s === 409 || s === 429 || s === 500 || s === 503 || s === 529) return true;
  const m = String(e?.message ?? "").toLowerCase();
  return m.includes("terminated") || m.includes("connection") || m.includes("overloaded");
}

const ORCH_ID = "orchestrator";
// Read-only grounding tools the Orchestrator may use directly (besides `delegate`).
const ORCH_GROUNDING = ["solution_overview", "find_symbol", "search_code", "read_file", "list_artifacts", "save_artifact"];

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
  agent: Agent,
  userMessage: string,
  emit: (e: any) => void,
  depth = 0
) {
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

  const messages: Anthropic.MessageParam[] = [
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
      try {
        const stream = anthropic.messages.stream({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: agent.systemPrompt,
          tools,
          messages,
        });
        stream.on("text", (delta) => {
          emittedThisAttempt++;
          emit({ type: "text_delta", text: delta });
        });
        resp = await stream.finalMessage();
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
          "Output hit the max_tokens limit and was truncated. Increase MAX_TOKENS or ask for a shorter document.",
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
            await runAgent(sub, task, subEmit, depth + 1);
          } catch (e) {
            subEmit({ type: "error", message: (e as Error).message });
          }
          emit({ type: "delegate_end", id: tu.id, agentId: sub.id });
          resultText =
            captured.join("").trim().slice(0, 8000) ||
            "(sub-agent completed; its output/artifact is available)";
        }
      } else {
        try {
          resultText = await callMcpTool(tu.name, (tu.input ?? {}) as Record<string, unknown>);
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
    emit({
      type: "text_delta",
      text: `\n\n_⚠ Reached the ${MAX_TURNS}-step limit before finishing — results above are partial. Re-run with a narrower scope, or raise MAX_TURNS_PER_RUN._`,
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

let agents: Agent[] = [];

app.get("/api/agents", (_req, res) => {
  const demo = activeProjectId === DEMO_ID;
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

app.get("/api/health", (_req, res) => {
  const p = activeProject();
  res.json({
    mcpReady,
    mcpError,
    mcpTools: mcpTools.map((t) => t.name),
    model: MODEL,
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    activeProject: p ? publicProject(p) : null,
  });
});

// ---- Projects API --------------------------------------------------------
app.get("/api/projects", (_req, res) => {
  res.json({ activeProjectId, projects: projects.map(publicProject) });
});

// Create a project from a local folder or a git repo, then activate it.
app.post("/api/projects", async (req, res) => {
  const { name, type, path: localPath, repoUrl, subPath } = req.body ?? {};
  try {
    if (!name || !type) throw new Error("name and type are required");
    const id = newId(name);
    let sourceRoot: string;
    let repoUrlOut: string | undefined;

    if (type === "local") {
      if (!localPath) throw new Error("A folder path is required for a local project.");
      const abs = path.resolve(String(localPath));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory())
        throw new Error(`Folder not found: ${abs}`);
      sourceRoot = subPath ? path.join(abs, String(subPath)) : abs;
    } else if (type === "git") {
      if (!repoUrl) throw new Error("A repository URL is required for a git project.");
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      const dir = path.join(WORKSPACE_DIR, id);
      try {
        await execFileP("git", ["clone", "--depth", "1", String(repoUrl), dir], { timeout: 300000 });
      } catch (e: any) {
        if (e?.code === "ENOENT") throw new Error("git is not installed or not on PATH.");
        throw new Error(`git clone failed: ${String(e?.stderr || e?.message || e).slice(0, 300)}`);
      }
      sourceRoot = subPath ? path.join(dir, String(subPath)) : dir;
      repoUrlOut = String(repoUrl);
    } else {
      throw new Error(`Unknown project type: ${type}`);
    }

    if (!fs.existsSync(sourceRoot)) throw new Error(`Source root not found after setup: ${sourceRoot}`);

    const project: Project = {
      id,
      name: String(name),
      type,
      sourceRoot,
      repoUrl: repoUrlOut,
      subPath: subPath ? String(subPath) : undefined,
      artifactsDir: path.join(ARTIFACTS_ROOT, id),
      createdAt: new Date().toISOString(),
    };
    projects.push(project);
    saveProjects();
    await activateProject(id); // spawn MCP + index now
    res.json({ ok: true, project: publicProject(project) });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

app.post("/api/projects/:id/activate", async (req, res) => {
  try {
    await activateProject(req.params.id);
    res.json({ ok: true, project: activeProject() ? publicProject(activeProject()!) : null });
  } catch (e) {
    mcpError = (e as Error).message;
    res.status(400).json({ ok: false, error: (e as Error).message });
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
  try {
    if (activeProjectId === id) await activateProject(DEMO_ID);
  } catch (e) {
    mcpError = (e as Error).message;
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
function safeArtifactPath(rel: string): string {
  const dir = activeProject()?.artifactsDir;
  if (!dir) throw new Error("No active project");
  const root = path.resolve(dir);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("Invalid path");
  return abs;
}

app.get("/api/artifacts", (_req, res) => {
  const p = activeProject();
  const files = p ? walkFiles(p.artifactsDir).sort((a, b) => b.mtime - a.mtime) : [];
  res.json({ projectId: p?.id, files });
});

app.get("/api/artifacts/content", (req, res) => {
  try {
    const abs = safeArtifactPath(String(req.query.path || ""));
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, path: req.query.path, content: fs.readFileSync(abs, "utf8") });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

app.get("/api/artifacts/download", (req, res) => {
  try {
    const abs = safeArtifactPath(String(req.query.path || ""));
    if (!fs.existsSync(abs)) return res.status(404).send("Not found");
    res.download(abs, path.basename(abs));
  } catch (e) {
    res.status(400).send((e as Error).message);
  }
});

// Diagnostics / offline-friendly: run a single MCP tool directly (no LLM).
app.post("/api/tool", async (req, res) => {
  if (!mcpReady) {
    res.status(503).json({ ok: false, error: mcpError ?? "MCP server still starting…" });
    return;
  }
  const { name, arguments: args } = req.body ?? {};
  try {
    const text = await callMcpTool(name, args ?? {});
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
  const emit = (e: any) => res.write(JSON.stringify(e) + "\n");

  if (!mcpReady) {
    emit({ type: "error", message: mcpError ?? "MCP server is still starting — try again in a moment." });
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

  try {
    emit({ type: "start", agent: agent.name, model: MODEL });
    await runAgent(agent, message, emit);
    emit({ type: "done" });
  } catch (e) {
    emit({ type: "error", message: (e as Error).message });
  } finally {
    res.end();
  }
});

// ---------------------------------------------------------------------------
function main() {
  agents = loadAgents();
  loadProjects();
  console.error(
    `[ui] ${agents.length} agents, ${projects.length} projects; active=${activeProjectId}`
  );

  // Listen immediately so the page loads instantly; connect MCP in the background.
  app.listen(PORT, () => {
    console.error(`\n  ASTRA AgenticOS →  http://localhost:${PORT}\n`);
    if (!process.env.ANTHROPIC_API_KEY)
      console.error("  ⚠  ANTHROPIC_API_KEY not set — set it for the live agents.\n");
  });

  activateProject(activeProjectId!).catch((e) => {
    mcpError = (e as Error).message;
    console.error("[mcp] connect failed:", mcpError);
  });
}

main();
