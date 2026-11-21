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

- **Documents** — no code at all. A project that is a set of **input documents** (Word, PDF, Markdown or
  text): requirement documents, briefs, a client's prompt. Documents are converted to Markdown and stored
  under the project's artifacts folder (`inputs/`), where agents read them with `list_artifacts` /
  `read_artifact`. They belong to that project alone — nothing is published to the shared Golden library,
  and they are deleted with the project. Add or remove them later from the Artifacts panel. (The code
  index ignores `.md` and `.txt`, which is why a documents project cannot be an ordinary folder.)

Golden items can also be **scoped to one project** (`?scope=<projectId>` on import, or `scope` when
creating an item) so a client's library is visible to that client's project only.

Endpoints: `GET /api/projects`, `POST /api/projects`, `POST /api/projects/:id/activate`,
`DELETE /api/projects/:id`, `GET|POST|DELETE /api/projects/:id/inputs` (the `POST` takes the raw file and
`?filename=`).

## Checks on deliverables written from documents

The **Requirements / BRD from Source Documents** agent is checked by the server after each
`save_artifact`, and the result is returned to the agent so it can fix the document while it still can
(`ui/src/source-checks.ts`): citations against the cited text (word-pair containment — it says where
wording is found when it is not in the cited source), sections against a bound template, the task's
prohibitions (user stories, acceptance criteria), and source conflicts it was shown by `compare_sources`.
Three more compare a requirement with the gaps, decisions and lists its source contains (`ui/src/source-gaps.ts`):
an Open Question that cites "Gap 2" or "Decision 3" must match an item of that number in the cited document; "None"
as the open questions of a requirement the source lists a gap about is reported with the item; and a statement that
names most of a source's bullet list but leaves items out is reported with the ones missing.
These are heuristics over text and report what they compared, not whether a claim is true.

A long document is built **one section at a time** with `write_section` (the server keeps the order,
composes the whole, and saves it each time) and finished with `check_document`. A correction changes
one section instead of re-sending the document: `patch_section` replaces exact text inside a section
(each `find` must match one place; all edits apply or none do), and `write_section` with the same title
rewrites a section when most of it changes. So the model generates about one copy of the document
rather than one per correction, and each section is checked the moment it is written. Whole-document
checks (template structure, conflicts recorded) run in `check_document` and again when the run ends.

### Independent review

The text checks cannot judge what a requirement means, and reviewers of live runs kept finding the same drift after
they passed: two source items merged into one requirement, list items dropped, a Gap number that raises another
question, "Not specified" followed by a dependency, a condition no source states. So `check_document` (and the end of
the run, if the agent never called it) also has a **second reader** (`ui/src/source-review.ts`): a separate model call
that did not write the requirements reads each one against the task prompt and input documents and reports what
differs, with the source wording and a replacement. The server discards any finding whose quoted source wording is not
in the sources, reads a requirement again only when its text has changed (at most twice), and hands the findings to the
writer, who fixes them with `patch_section`. Set `SOURCE_REVIEW=off` to disable it, `REVIEW_MODEL` to use another model
for the reader (default: `MODEL`), `REVIEW_BATCH` for requirements per call (default 8), `REVIEW_CONCURRENCY` for calls
side by side (default 5). The reader returns only the requirements with problems and lists the IDs that passed.

### Parallel drafting

One writer producing ~100 requirements one after another, then fixing them one patch per turn, took 22–38 minutes and
made the same mistakes run after run (Gap numbers from the wrong area, invented dependencies, merged lists). So the
requirements and the long chapters are written in parallel (`ui/src/requirement-drafts.ts`):

- `draft_requirements` — the agent maps each feature group of the scope to the heading(s) of the input-document
  section it comes from. One writer per area gets that section in front of it (all writers share one cached copy of the
  full sources), writes the area in a fixed form, and then, side by side with the other areas, goes through up to
  `DRAFT_FIX_ROUNDS` (default 3) rounds of server checks + independent review + fix, each fix returning only the
  requirements it changes. The server renumbers the IDs across areas and carries what the reviewer read into the run, so
  `check_document` re-reads only what changed.
- `draft_chapters` — business objectives, success criteria, audience, stakeholders, key features (split into groups of
  at most four features or roles): one writer each, checked and corrected with find/replace edits for up to
  `DRAFT_CHAPTER_ROUNDS` (default 4) rounds within `DRAFT_CHAPTER_BUDGET_MS` (default 240 s).
- Both return at once with placeholders in the document; numbered sections fall into number order whatever order they
  are written in; `check_document` waits for them. In a drafted run `check_document` may be called at most
  `DRAFTED_CHECK_LIMIT` (default 2) times, and the writer is told to fix fail findings and real defects, not minor ones.
  At `check_document`, the reviewer's *fail* findings go back to their areas' writers as changes, in parallel
  (`DRAFT_REFIX`: `fail` default, `on` for every finding and chapter check too, `off`). An area the agent gives several
  of the sources' own areas is split into one writer per source area. `DRAFT_CONCURRENCY` (default 16), `DRAFT_MODEL`
  (default `MODEL`).
- Models: Sonnet 5.5 and Opus 5.5 reject a forced `tool_choice`; the reviewer then asks for its tool by name instead.
  Measured on a client BRD (30 sampled requirements): Sonnet 5.5 throughout 26/4/0 pass/minor/fail in 5.5 min; Opus 5.5 as
  `REVIEW_MODEL` 26/4/0 in 8.2 min; Haiku 5.5 as `REVIEW_MODEL` 24/5/1 in 7.5 min. Keep the reviewer on `MODEL`.
- Open Questions quote the source's Gap / Decision / Risk verbatim, so a reworded item is caught by the quote check;
  a dependency stated inside the area's own Gap/Decision/Risk goes in Dependencies; the citation check skips sentences
  that say the source is silent or label themselves as the document's inference.

On a client's inputs this took a run from 22–24 minutes to 5.5–8 (Sonnet 5.5) or 10–15 (Sonnet 4.6), and the
sampled requirements from 13 pass / 6 fail (of 30) to 23–26 pass / 0 fail.

### Run performance

Each run logs a `[perf]` line (and emits `turn`, `tool_time` and `perf` events): model time and turns, tool time by
tool, tokens, and the reviewer's and drafters' calls. A model stream that sends nothing for `STREAM_IDLE_MS` (default
90 s) is cut and retried; reviewer calls time out after `REVIEW_CALL_TIMEOUT_MS` (default 240 s).

## Evaluating changes

`npm run eval` runs fixed cases against a live server (it costs model calls) and scores them against
`ui/eval/baseline.json`: hard properties (requested sections, nothing forbidden, nothing invented, conflicts
and gaps recorded, inputs read in full) must hold on every run, and soft ones (citation miss rate, length)
must stay within tolerance. Each run uses a throwaway project with no Golden items, so the result does not
depend on the library. `npm test` runs the model-free suites, including the scoring rules.

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
