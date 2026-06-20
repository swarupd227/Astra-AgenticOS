# ASTRA AgenticOS — 2–3 minute demo video run-book

A one-take script to screen-record the key agents running against a selected repo. The animated
walkthrough in chat shows the same flow if you'd rather embed that.

## Before you record (pre-flight)
- Server running: `cd ui; npm start` → open **http://localhost:5173** (hard-refresh once).
- `ANTHROPIC_API_KEY` set in `ui/.env`; status pill is green.
- **Pre-warm** each agent you'll show by running its prompt once beforehand (the first run builds the
  Roslyn index ~10s and the artifacts appear in the drawer). This keeps the recording snappy.
- Theme: dark (default) for contrast. Zoom browser to ~110%.
- **Recording tool (Windows):** press `Win + Alt + R` (Xbox Game Bar) to start/stop, or use OBS.

> Timing note: live agent runs take ~1–3 min each. For a tight 2–3 min video either (a) pre-run them
> and narrate over the **Artifacts** drawer, or (b) record each run and **speed up 2–4×** in editing,
> or (c) show the tool-call chips streaming, then cut to the finished report. The script below assumes
> light editing.

---

## Scene 1 — "Point it at a codebase" (0:00–0:20)
- Show the landing screen: agents **grouped by SDLC area** in the sidebar; the **project switcher**
  (top-right) reads **nopCommerce 3.90 (demo)**.
- Click the switcher to reveal **New project… (local folder / git repo)**. Say: *"Point ASTRA at any
  local folder or git repo — it indexes the real code; nothing is guessed."* Close the menu.

## Scene 2 — Impact Analysis (the "wow") (0:20–1:05)
- Sidebar → **Requirements & Analysis → Impact Analysis**.
- Click the suggested prompt: *"I need to change how tax is calculated — specifically `TaxService`.
  What is the blast radius and what must I re-test?"*
- Point out, as it streams: the **tool-call chips** (`analyze_impact` running → ✓), then the report —
  **MEDIUM risk, ~22 dependent files**, and that it caught the **PayPal plugins** depend on tax.
  Say: *"Grounded in the real reference graph — a free, local CAST-Imaging equivalent."*

## Scene 3 — Orchestrator delegating (1:05–2:00)
- Sidebar → **Orchestration → Orchestrator**.
- Prompt: *"I want to safely change how tax is calculated. Plan and run the right agents, then give me
  a consolidated report."*
- Point out: the **plan table**, then the **nested delegation cards** appearing one by one
  (→ Impact Analysis, → Requirements/BRD, → Test Generator) each doing real tool calls, then the
  **consolidated synthesis** at the end. Say: *"One agent coordinating the others — plan, delegate,
  synthesise."* (Pre-run this; narrate over the finished thread to stay in budget.)

## Scene 4 — Brownfield value: Config & Secrets Auditor (2:00–2:40)
- Sidebar → **Security → Config & Secrets Auditor**.
- Click its suggested prompt. Point out the **Critical findings**: plaintext credentials seeded into
  the DB, `debug="true"` in the production `Web.config` — each citing the exact file. Say: *"Reads the
  actual `web.config` files — bank-grade hygiene in seconds."*

## Scene 5 — Artifacts + close (2:40–3:00)
- Click the **Artifacts** icon (top-right) → show the generated deliverables (BRD, impact report,
  config audit, OpenAPI, etc.); open one to show rendered markdown; hit **Download**.
- Close on the sidebar: *"28 agents across the whole SDLC — requirements to design, build, test,
  security, ops, modernization and a human-review gate — all on the same MCP server, pointable at any
  repo."*

## Suggested prompts to keep handy (copy/paste)
- Impact Analysis: `Blast radius of changing TaxService and what must I re-test?`
- Orchestrator: `Safely change how tax is calculated — plan and run the right agents, then a consolidated report.`
- Config & Secrets: `Audit the web.config files for secrets and insecure settings.`
- Dead Code: `Find likely dead code in Nop.Services.Tax with confidence levels.`
- Modernization: `Assess this solution for migration to .NET 10 with a phased roadmap.`
