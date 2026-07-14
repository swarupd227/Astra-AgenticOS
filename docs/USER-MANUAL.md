# ASTRA AgenticOS — User Manual

A step-by-step guide to every feature of the ASTRA AgenticOS web app: 28 SDLC agents that read your
real .NET code and answer with grounded, cited output.

---

## Contents
1. [What ASTRA is](#1-what-astra-is)
2. [Starting & opening the app](#2-starting--opening-the-app)
3. [First-time setup: your API key](#3-first-time-setup-your-api-key)
4. [The interface at a glance](#4-the-interface-at-a-glance)
5. [Projects: pointing ASTRA at code](#5-projects-pointing-astra-at-code)
6. [Running an agent](#6-running-an-agent)
7. [Reading an agent's output](#7-reading-an-agents-output)
8. [The Orchestrator (multi-agent runs)](#8-the-orchestrator-multi-agent-runs)
9. [Artifacts: viewing & downloading deliverables](#9-artifacts-viewing--downloading-deliverables)
10. [Settings (API key & model)](#10-settings-api-key--model)
11. [Light / dark theme](#11-light--dark-theme)
12. [The 28 agents — catalog & example prompts](#12-the-28-agents--catalog--example-prompts)
13. [Worked example: a safe change, end-to-end](#13-worked-example-a-safe-change-end-to-end)
14. [Tips & best practices](#14-tips--best-practices)
15. [Troubleshooting](#15-troubleshooting)
16. [FAQ](#16-faq)

---

## 1. What ASTRA is

ASTRA AgenticOS is a browser app that gives you a team of **28 specialist AI agents** covering the
whole software lifecycle — requirements, design, implementation, testing, code health, security, ops,
modernization, and a human-review gate. Every agent reads your **actual source code** through a local
code-intelligence server (the "MCP server"), so answers are **grounded and cite `file.cs:line`**
rather than being guessed.

You point ASTRA at a **project** (a local folder or a git repository), pick an **agent**, and ask a
question in plain language. The agent calls tools on your code, streams its reasoning live, and
produces an answer — often saved as a downloadable **artifact** (a BRD, an ADR, a threat model, tests,
a pipeline, etc.).

---

## 2. Starting & opening the app

You reach ASTRA at a URL in your browser. How it's started depends on how it was deployed:

| How it's run | Open at | Reference |
|---|---|---|
| Local (Node) | `http://localhost:5173` | `ui/README.md` |
| Local (Docker) | `http://localhost:5173` | README → "Run with Docker" |
| Azure | `https://<app>.azurewebsites.net` (or your Container Apps URL) | `docs/DEPLOY-AZURE.md` |

> **Tip:** if you just started it or changed the UI, do a **hard refresh** (Ctrl+F5) to bypass cached
> assets.

When the app loads, look at the **status pill** in the top-right:
- **Green** (`claude-sonnet-4-6 · N tools`) — ready.
- **Amber** (`no API key…`) — you need to add a key (§3).
- **Amber** (`connecting to MCP…` / `indexing…`) — the code index is building; wait a few seconds.
- **Amber** (`MCP error`) — the active project has no readable source (see §15).

---

## 3. First-time setup: your API key

The agents need an Anthropic API key. There are three ways to provide it; the easiest is in-app.

**Option A — in the app (recommended):**
1. Click the **gear icon** (Settings) in the top-right.
2. In **Anthropic API key**, paste your key (starts with `sk-ant-`).
3. (Optional) set a **Model** (default `claude-sonnet-4-6`).
4. Click **Save**. The status pill turns green — you're ready.

**Option B — `ui/.env` file** (for local/Docker): put `ANTHROPIC_API_KEY=sk-ant-...` in `ui/.env`.

**Option C — environment variable / Azure app setting** (`ANTHROPIC_API_KEY`).

> Your key is stored locally on the server and only ever sent to Anthropic. In a container it's
> best to set it as an env var / app setting so it survives restarts (the in-app Settings write is
> lost if the container is recreated).

---

## 4. The interface at a glance

**Top bar (left → right):**
- **ASTRA logo + name** — the product.
- **Project switcher** (center) — a pill showing the active project; click to switch or add a project (§5).
- **Status pill** — model + tool count, or a warning.
- **Artifacts** (inbox icon, with a count badge) — generated deliverables (§9).
- **Settings** (gear) — API key & model (§10).
- **Theme toggle** (sun/moon) — light/dark (§11).

**Left sidebar — Agents:** all 28 agents, grouped by SDLC **area** (Orchestration, Requirements &
Analysis, Design, Implementation, Quality & Testing, Code Health, Security, Ops & Delivery,
Modernization, Memory & Context, Human Review). Each card shows the agent's name + a one-line
description. The footer shows **which project you're grounded in**.

**Main area:** starts on a welcome screen; becomes the **conversation** once you pick an agent and ask.

**Composer (bottom):** the text box where you type. `Enter` sends; `Shift+Enter` adds a newline.

---

## 5. Projects: pointing ASTRA at code

A **project** is the codebase ASTRA analyses. The active project's name shows in the top project pill,
and "Grounded in \<project\>" shows in the sidebar footer.

### 5.1 Switch to an existing project
1. Click the **project pill** at the top.
2. In the dropdown, click any project. A brief **"Switching… / Indexing…"** overlay appears while ASTRA
   re-points the code server and rebuilds the index.
3. When it finishes, the status pill returns to green and the agents now analyse that project.

### 5.2 Add a project from a local folder
1. Click the **project pill** → **New project…**
2. Choose the **Local folder** tab.
3. Enter a **Project name** (anything, e.g. "Payments Service").
4. Enter the **Folder path** — an absolute path to the .NET source on the machine running ASTRA
   (e.g. `C:\src\payments`). *(Only works when ASTRA can see that path — i.e. local runs, or a path
   mounted into the container.)*
5. (Optional) **Sub-folder to index** — e.g. `src` to index just that part.
6. Click **Create & index**. ASTRA indexes it and switches to it automatically.

### 5.3 Add a project from a git repository
1. Click the **project pill** → **New project…**
2. Choose the **Git repository** tab.
3. Enter a **Project name**.
4. Enter the **Repository URL** (e.g. `https://github.com/org/repo.git`). Public repos work as-is;
   private repos need credentials configured in the server's git environment.
5. (Optional) **Sub-folder to index** (e.g. `src`).
6. Click **Create & index**. ASTRA **clones** the repo, indexes it, and switches to it. *(This is the
   way to give a cloud/Docker deployment something to analyse.)*

### 5.4 Remove a project
1. Open the **project pill** dropdown.
2. Hover a project and click the **trash icon** (the bundled demo project can't be removed).
3. Confirm. For git projects, the cloned files are deleted; local-folder projects leave your source
   untouched.

> **Indexing note:** the first analysis of a project builds a code index (a few seconds for small
> repos, ~10–15s for large ones like nopCommerce). It's cached for the session.

---

## 6. Running an agent

1. **Pick an agent** in the left sidebar (browse by area). The main panel shows the agent's name,
   description, its tools, and a few **suggested prompts**.
2. **Ask**, one of two ways:
   - Click a **suggested-prompt card** — it runs immediately, or
   - Type your own question in the composer and press **Enter**.
3. Watch it work (see §7). When done, you can **Copy** the answer, and any saved file appears in
   **Artifacts** (§9).

You can ask **follow-up questions** in the same thread — each is a fresh, independent run (agents don't
carry memory between messages, so make each prompt self-contained).

To work with a **different agent**, just click it in the sidebar (this starts a new conversation).

---

## 7. Reading an agent's output

An agent's reply is built live from several parts:

- **"Thinking…"** — the agent is starting.
- **Tool-call chips / a "Working" panel** — each call the agent makes to your code (e.g.
  `analyze_impact`, `find_references`, `read_file`) shows as a step with a spinner → green **✓ done**.
  Click a step to expand the raw tool output. When finished it collapses to **"Used N tools."**
- **Streamed answer** — the written response appears token-by-token as Markdown (headings, tables,
  syntax-highlighted code).
- **Artifact card** — if the agent saved a deliverable (BRD, ADR, tests…), a card shows the filename;
  it's also added to the Artifacts drawer.
- **Copy** — a button under the answer copies the full text.

If an agent reports **"Reached the step limit"**, it did a lot of analysis before finishing — re-run
with a narrower scope, or ask for a shorter output.

---

## 8. The Orchestrator (multi-agent runs)

The **Orchestrator** (top of the sidebar) is special: give it a high-level goal and it runs the *other*
agents for you.

1. Select **Orchestrator**.
2. Ask a goal, e.g. *"I want to safely change how tax is calculated — plan and run the right agents,
   then give me a consolidated report."*
3. You'll see it:
   - state a **plan** (which agents, in what order),
   - then **delegate** — each sub-agent appears as its own **nested card** (`→ Impact Analysis`,
     `→ Requirements / BRD`, `→ Test Generator`) doing its own tool calls, and
   - finish with a **consolidated synthesis** and (optionally) a saved report.
4. Click any delegation card to expand/collapse what that sub-agent did.

Use the Orchestrator when a task spans multiple steps; use an individual agent for a single, focused
question.

---

## 9. Artifacts: viewing & downloading deliverables

Whenever an agent saves a document (BRD, ADR, threat model, tests, pipeline, audit…), it becomes an
**artifact** for the current project.

1. Click the **inbox icon** (top-right); the number badge shows how many exist.
2. The **Artifacts drawer** slides in, listing files (name, size, time), newest first.
3. **Click a file** to open the **viewer** — Markdown is rendered; code is syntax-highlighted.
4. Click **Download** (in the viewer, or the download icon on the row) to save it.

Artifacts are **per project** — switching projects shows that project's own artifacts. The list
refreshes automatically after each run.

---

## 10. Settings (API key & model)

1. Click the **gear icon** (top-right).
2. **Anthropic API key** — paste a new key to change it (leave blank to keep the current one; the hint
   shows the last 4 characters if a key is already set).
3. **Model** — the Claude model to use (default `claude-sonnet-4-6`; you can set e.g. `claude-opus-4-8`).
4. Click **Save** — changes apply immediately, no restart needed.

---

## 11. Light / dark theme

Click the **sun/moon icon** (top-right) to toggle between light and dark. Your choice is remembered on
that browser.

---

## 12. The 28 agents — catalog & example prompts

Full one/two-line descriptions are in [`AGENTS.md`](AGENTS.md). Below is a quick catalog with a sample
prompt for each. (Replace names like `TaxService` with something from *your* codebase.)

### Orchestration
- **Orchestrator** — *"Assess this codebase end-to-end and tell me the top risks, using the right agents."*

### Requirements & Analysis
- **Requirements / BRD** — *"Generate a BRD for the checkout tax calculation."*
- **Impact Analysis** — *"What's the blast radius of changing TaxService and what must I re-test?"*
- **Traceability** — *"Build a requirements-to-code traceability matrix for shopping-cart tax."*
- **Spec Validator** — *"Validate the tax-calculation requirements — complete, unambiguous, testable, and matching the code?"*

### Design
- **Architecture / ADR** — *"Give me an architecture overview of this solution."*
- **Data Model** — *"Recover the data model for the customer & order domain as an ERD."*
- **API Contract** — *"Generate an OpenAPI contract for the ShoppingCart controller."*

### Implementation
- **Code Generation** — *"Add a wholesale-customer tax exemption, following TaxService's patterns."*
- **Refactor** — *"Find duplication in OrderTotalCalculationService and propose safe refactors."*

### Quality & Testing
- **Test Generation** — *"Write NUnit tests for TaxService in the existing style."*
- **Test Coverage / Gaps** — *"What isn't tested in TaxService, ranked by risk?"*
- **Code Review** — *"Review TaxService.cs for correctness and security."*
- **Regression** — *"Review my pending changes for regression risk and give a re-test plan."*
- **Dead Code & Cleanup** — *"Find likely dead code in Nop.Services.Tax with confidence levels."*
- **Characterization Tests** — *"Write golden-master tests pinning TaxService's current behaviour."*

### Code Health
- **Reliability & Error Handling** — *"Find swallowed exceptions and missing logging in Nop.Services."*
- **Async & Performance** — *"Find sync-over-async and N+1 queries in the order/checkout services."*
- **Data-Access Risk** — *"Audit the data-access layer for SQL injection and EF anti-patterns."*

### Security
- **Security / Threat Model** — *"STRIDE threat model for the checkout & payment flow."*
- **Config & Secrets Auditor** — *"Audit web.config files for secrets and insecure settings."*

### Ops & Delivery
- **CI/CD Pipeline** — *"Generate a CI/CD pipeline for this solution."*
- **Observability & Rollback** — *"Deployment readiness pack for the order-placement flow."*

### Modernization
- **Modernization (.NET 10)** — *"Assess this solution for migration to .NET 10 with a phased roadmap."*

### Memory & Context
- **Dependency Mapper** — *"Map the project & NuGet dependencies; flag layering violations and stale packages."*
- **Changelog** — *"Generate a changelog from recent commit history."*
- **Tech-Debt Hotspot Prioritizer** — *"Rank the tech-debt hotspots and tell me what to tackle first."*

### Human Review
- **Human Review (HITL Gate)** — *"Produce a go/no-go review gate for the tax-calculation change using the artifacts generated."*

---

## 13. Worked example: a safe change, end-to-end

A typical brownfield workflow, chaining agents:

1. **Impact Analysis** — *"Blast radius of changing TaxService?"* → see who depends on it.
2. **Test Coverage / Gaps** — *"What isn't tested in TaxService?"* → find the gaps.
3. **Characterization Tests** — *"Pin TaxService's current behaviour with golden-master tests."* → safety net.
4. **Code Generation** — *"Add the new rule following TaxService's patterns."* → the change (a proposal).
5. **Code Review** + **Regression** — review the proposal and assess risk of the diff.
6. **Human Review (HITL Gate)** — produce the approval pack for sign-off.

Open the **Artifacts** drawer at the end to download everything produced. Or hand the whole goal to the
**Orchestrator** and let it run the sequence for you.

---

## 14. Tips & best practices

- **Warm-up:** the first request after selecting/switching a project builds the index (~10s). Later
  requests are fast.
- **Be specific:** name the class/feature/flow. "Review `TaxService.cs`" beats "review the code".
- **Self-contained prompts:** agents don't remember previous messages — include the context each time.
- **Use suggested prompts** to learn what each agent does well, then adapt them.
- **Orchestrator for goals, single agents for questions.**
- **Point at the right project first** (check the project pill) before asking.
- **Cite-checking:** every claim should reference `file.cs:line`; open the referenced file to verify.

---

## 15. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **"MCP error"** in the status pill; **"Source root not found: …"** in a reply | The active project's code isn't present (common in cloud where nothing is mounted). | Add a project via **New project → Git repository** (or Local folder). It clones/indexes and the error clears. |
| Status pill: **"no API key"** | No key configured. | Open **Settings** (gear) and paste your key (§3). |
| Reply: **"ANTHROPIC_API_KEY is not set…"** | Same as above. | Set the key in Settings. |
| First reply is **slow** | Index is building for a new/switched project. | Wait ~10–15s; subsequent replies are fast. |
| **"Reached the step limit…"** | Deep analysis used all its turns before finishing. | Narrow the scope, or ask for a shorter output. |
| A brief **"Reconnecting to the model…"** appears | Transient network blip to the API. | It auto-retries; no action needed. |
| Agent saved to an artifact but reply looks short | The deliverable went to the artifact. | Open the **Artifacts** drawer and view/download it (§9). |

---

## 16. FAQ

**Does ASTRA change my code?** No. It reads code and produces documents/proposals. The Code Generation
agent outputs a *proposal* artifact; it never edits your repository.

**Where does my code go?** Nowhere — indexing is local to the server running ASTRA. Only your prompts
and the relevant code excerpts the agent reads are sent to Anthropic to produce the answer.

**Can I use it on a private/internal repo?** Yes — point a Local-folder project at it, or use a Git
repository URL with credentials configured on the server.

**Which model does it use?** Claude (default `claude-sonnet-4-6`), changeable in Settings.

**Is it the same as the GitHub Copilot agents?** Yes — the same agent personas run in VS Code Copilot
and in this UI, backed by the same code-intelligence (MCP) server.

**How do I run/deploy it?** See `ui/README.md` (local), the README "Run with Docker" section, and
`docs/DEPLOY-AZURE.md` (Azure).
