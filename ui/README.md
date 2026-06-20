# ASTRA AgenticOS — Visual Demo UI

A chat-style web UI that drives the same SDLC agents as VS Code, but in a browser. It connects to
the **same C# MCP server** over stdio (so every tool call is genuinely grounded in nopCommerce) and
uses the **Anthropic Claude API** to run the agentic loop — picking tools and writing prose — with
the tool invocations shown live, just like Copilot in VS Code.

```
Browser (chat UI)
   │  POST /api/chat  (NDJSON stream of tool_call / tool_result / text)
Node/Express + Anthropic SDK     ← runs the agent loop (system prompt = .github/agents/*.agent.md)
   │  MCP stdio
C# MCP server (SdlcAgents.Mcp)   ← the same server VS Code uses; Roslyn over nopCommerce
```

## Prerequisites

1. Build the MCP server and clone the demo codebase (from repo root):
   ```powershell
   ./scripts/setup.ps1
   ```
2. Node 18+ and an Anthropic API key.

## Run

```bash
cd ui
npm install
# PowerShell:
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm start
```

Open <http://localhost:5173>. Pick an agent, click a suggested prompt (or type your own), and watch
the tool calls run against real source.

> The first prompt triggers a one-time Roslyn index of nopCommerce (~10s); it's warmed automatically
> on startup. The status pill turns green when the MCP server is connected.

## Projects — run the agents against any codebase

The agents run against the **active project**. Use the **project switcher** in the top-right to
add or switch projects:

- **Local folder** — point at any folder containing .NET source (absolute path). Optionally index
  just a sub-folder (e.g. `src`).
- **Git repository** — paste a repo URL; ASTRA shallow-clones it into `workspace/<id>/` and indexes
  it. (Requires `git` on PATH. Public repos work out of the box; private repos need credentials
  configured in your git environment.)

Switching a project re-points the MCP server at the new source root and re-indexes (a few seconds
for a small repo, ~10s for a large one like nopCommerce). The **nopCommerce 3.90 demo** project is
always present and can't be removed. Project definitions persist in `ui/projects.json` (gitignored).

Endpoints: `GET /api/projects`, `POST /api/projects`, `POST /api/projects/:id/activate`,
`DELETE /api/projects/:id`.

## Config (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `ANTHROPIC_API_KEY` | — | Required for the live agents |
| `MODEL` | `claude-sonnet-4-6` | Override the model (e.g. `claude-opus-4-8`) |
| `PORT` | `5173` | HTTP port |
| `MAX_TOKENS` | `16000` | Max output tokens per turn (large docs need headroom) |

> The source root and artifacts folder are no longer env vars — they're set **per project**
> (see above) and the server points the MCP server at the active project automatically.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/agents` | Agent personas + per-agent tool scope + suggested prompts |
| `GET /api/health` | MCP readiness, tool list, model, whether an API key is set |
| `POST /api/chat` | Streamed agent run (NDJSON events) |
| `POST /api/tool` | Run a single MCP tool directly (no LLM) — handy for diagnostics / offline |

## How it stays faithful to VS Code

- The agent **personas are the exact same `.github/agents/*.agent.md` files** Copilot uses — loaded
  as the system prompt.
- The **tools are the exact same MCP server** Copilot launches via `.vscode/mcp.json`.
- Per-agent tool scoping mirrors the `tools:` frontmatter in each agent file.

So the only thing swapped is the host (browser + Claude API instead of VS Code + Copilot) — the
agents and their grounding are identical.
