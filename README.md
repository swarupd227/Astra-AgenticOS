# ASTRA AgenticOS — SDLC Agents for GitHub Copilot (CommerzBank Demo)

A set of **SDLC agents** invoked through **GitHub Copilot** (VS Code), grounded in a real
**.NET Framework 4.5.1 / ASP.NET MVC** codebase ([nopCommerce 3.90](https://github.com/nopSolutions/nopCommerce))
so the productivity story is concrete on a legacy stack.

## What's inside

| Layer | What it is | Where |
|-------|-----------|-------|
| **Copilot Custom Agents** | 28 SDLC personas (grouped by area) the team invokes from Copilot's agent picker | [`.github/agents/`](.github/agents/) |
| **Auto-applied instructions** | .NET Framework / C# coding standards (reused from [github/awesome-copilot](https://github.com/github/awesome-copilot)) | [`.github/instructions/`](.github/instructions/) |
| **SDLC MCP Server** | C# / .NET 9 server giving agents *grounded* code intelligence (Roslyn-backed find-usages, impact analysis) | [`src/SdlcAgents.Mcp/`](src/SdlcAgents.Mcp/) |
| **VS Code wiring** | Registers the MCP server for Copilot | [`.vscode/mcp.json`](.vscode/mcp.json) |
| **Visual demo UI** | Browser chat app that drives the same agents via the same MCP server (live Claude API) | [`ui/`](ui/) |
| **User manual** | Step-by-step guide to every feature of the app | [`docs/USER-MANUAL.md`](docs/USER-MANUAL.md) |
| **Demo materials** | Design + minute-by-minute demo script | [`docs/`](docs/) |

## The 28 agents (grouped by SDLC area)

**Orchestration** — **Orchestrator**: plans, **delegates to the other agents**, and synthesises one consolidated report.

**Requirements & Analysis** — **Requirements/BRD** (recover a BRD from code) · **Impact Analysis** ("what breaks if I change X?") · **Traceability** (requirements ↔ code ↔ tests) · **Spec Validator** (spec completeness / ambiguity / testability vs code).

**Design** — **Architecture/ADR** · **Data Model** (ERD from EF entities) · **API Contract** (OpenAPI 3 from controllers).

**Implementation** — **Code Generation** (change in the codebase's own conventions) · **Refactor** (safe, behaviour-preserving cleanup).

**Quality & Testing** — **Test Generation** (NUnit in house style) · **Test Coverage/Gaps** · **Code Review** (.NET + security) · **Regression** (risk of a diff via git + impact graph) · **Dead Code & Cleanup** (unused members/files) · **Characterization Tests** (golden-master tests for legacy).

**Code Health** — **Reliability & Error Handling** (swallowed exceptions, lost stack traces) · **Async & Performance** (sync-over-async, N+1, blocking I/O) · **Data-Access Risk** (SQL injection, EF anti-patterns).

**Security** — **Security / Threat Model** (STRIDE, grounded in code) · **Config & Secrets Auditor** (secrets / connection strings / insecure settings).

**Ops & Delivery** — **CI/CD Pipeline** (framework-aware GitHub Actions / Azure DevOps) · **Observability & Rollback** (golden signals + rollback runbook).

**Modernization** — **Modernization (.NET 10)** (blocker inventory + phased roadmap).

**Memory & Context** — **Dependency Mapper** (project + NuGet graph, layering violations) · **Changelog** (release notes from git history) · **Tech-Debt Hotspot Prioritizer** (churn × complexity × coupling).

**Human Review** — **Human Review (HITL Gate)** — assembles a go/no-go review packet (checklist, risk tier, sign-offs, escalation) from the produced artifacts.

All 28 reuse the **same MCP server**. The **Orchestrator** adds an agent-runs-agents delegation layer
in the UI backend. The MCP server's `read_file`/`search_code` cover source (`.cs`, Roslyn-indexed)
**and** project/config files (`.csproj`, `packages.config`, `web.config`, `.sln`…); a **git** tool
group (`git_status`/`git_log`/`git_diff`/`git_show`) backs the Regression, Changelog and Human-Review
agents.

## Quick start

```powershell
# 1. Clone the demo codebase + build the MCP server
./scripts/setup.ps1

# 2a. VS Code path: open this folder, pick an agent in Copilot Chat, try the prompts in:
#     docs/DEMO-SCRIPT.md
#
# 2b. Browser path (visual demo UI):
#     cd ui; npm install; $env:ANTHROPIC_API_KEY="sk-ant-..."; npm start
#     then open http://localhost:5173   (see ui/README.md)
```

## Run with Docker

The image bundles the Node UI **and** the .NET runtime that hosts the MCP server.

```bash
# 1. Provide your key (compose reads ui/.env)
cp ui/.env.example ui/.env      # then set ANTHROPIC_API_KEY
# 2. Put the .NET codebase you want to analyse into ./workspace  (or edit the volume in docker-compose.yml)
# 3. Build + run
docker compose up --build
```

Then open **http://localhost:5173** (map a different host port with e.g. `ports: ["8080:5173"]`).
The mounted `./workspace` becomes the active project (via `SEED_PROJECT_ROOT`); you can also add more
projects from the UI: **upload a .zip** of a codebase, **clone a git repo** (private repos take an
access token), or point at a local folder. Generated artifacts persist to `./artifacts`.

> **Iterating on the UI?** The image **bakes in** `ui/`, so editing files on the host does **not**
> change a running container — rebuild (`docker compose up --build`) to see UI/server changes.
> For fast iteration run it natively instead (`cd ui; npm start`), which serves the files directly.

**Persistence.** Three env vars decide what outlives the container — all default to paths *inside* the
image, so setting them is what makes a deployment stateful:

| Var | Holds | Compose default |
|---|---|---|
| `STATE_DIR` | projects + conversation history | `/app/state` → `./data` |
| `ARTIFACTS_DIR` | generated BRDs / ADRs / test plans | `/app/artifacts` → `./artifacts` |
| `WORKSPACE_DIR` | cloned repos **and uploaded codebases** | `/app/state/repos` → `./data/repos` |

`MAX_UPLOAD_MB` (default `300`) caps the .zip upload size.

**Tuning knobs** (all optional, read at startup):

| Var | Default | Raise it when |
|---|---|---|
| `MAX_TOKENS` | `32000` | A long deliverable is cut off ("the answer was cut off at the … output limit"). Models support up to `128000`. |
| `MAX_TURNS_PER_RUN` | `44` | Deep analysis stops at the step limit before finishing |
| `HEARTBEAT_MS` | `15000` | Rarely — lower it only if a proxy times out faster than ~230s |
| `REQUEST_TIMEOUT_MS` | `1800000` | Very large uploads over slow links |
| `MEMORY_MESSAGES` | `10` | Agents should remember more of the conversation |

**Deploy to Azure:** copy-paste Cloud Shell commands are in [`docs/DEPLOY-AZURE.md`](docs/DEPLOY-AZURE.md)
(build in ACR → Web App for Containers, with an ACI alternative).

See [`docs/DESIGN.md`](docs/DESIGN.md) for the architecture and [`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md) for the walkthrough.

## Architecture (one line)

**Copilot** reasons → **Custom Agents** supply the persona/workflow → **MCP Server** supplies
grounded code facts. Same MCP server works with Claude or any MCP client (demo-day fallback).
