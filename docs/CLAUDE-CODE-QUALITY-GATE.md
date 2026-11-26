# Use the AgenticOS quality gate from Claude Code

Write the document in Claude Code as you normally would. The gate checks it against the documents it was written from,
with the same wording checks the AgenticOS web app runs. It is deterministic, calls no model, needs no API key, writes
nothing and sends nothing anywhere.

## What you get

| Tool | When | What it does |
|---|---|---|
| `compare_sources` | Before writing | Terms your source documents define in unlike words |
| `check_document` | After writing or editing | Citations not found in the cited source, quotes that are not verbatim, source items no requirement covers, lists cut short, invented roles and dependencies, stronger wording than the source, duplicates, broken references |
| `review_instructions` | Before sharing | The brief for a second reader (a subagent that did not write the document), for what wording checks cannot judge |

Not included: template conformance and the web app's automatic reviewer loop.

## Set up (once per developer)

You need a current Node.js (tested with Node 24) and a clone of this repository.

```powershell
cd <path-to-AgenticOS>\ui
npm install
```

Then register the server with Claude Code, from the project you want to check documents in:

```powershell
claude mcp add agenticos-gate -- node <path-to-AgenticOS>/ui/node_modules/tsx/dist/cli.mjs <path-to-AgenticOS>/ui/src/quality-mcp.ts
```

Use full paths. The gate reads only files inside the folder Claude Code was started in (set `GATE_ROOT` to change it).
Keep the AgenticOS clone on a local disk: from a synced folder the server can take 20 seconds or more to start, and if
Claude Code reports a start-up timeout, set `MCP_TIMEOUT=60000` before starting it.

To check citations of Golden Repository items (`GLD-…`), set `GOLDEN_DIR` to the repository folder and, to limit what
may be read, `GOLDEN_ITEMS` to a comma-separated list of ids.

## Use it

Ask Claude Code in your own words, for example:

> Write requirements from docs/spec.md into docs/brd.md. Compare the sources first. Then run check_document, fix what it
> finds, and run it again. Finally have a new subagent review the document using review_instructions. Tell me every
> finding you did not fix and why.

The gate reads requirements written like this:

```markdown
#### REQ-001 — Fleet Commitment

**Requirement Statement:** A confirmed reservation should commit fleet capacity for the requested rental period.

**Source Reference:** `docs/spec.md` — Reservations › Fleet Commitment: “A confirmed reservation should commit …”

**Priority:** Not specified in source.

**Dependencies:** Not Specified.

**Open Questions:** None identified in source.
```

Source documents must be Markdown or text. Cite each by its path or by its file name in backticks.

## In a pipeline

The same checks run as a command. It exits `0` with no findings, `1` with findings and `2` when it could not run.

```powershell
npm --prefix <path-to-AgenticOS>/ui run gate -- check docs/brd.md docs/spec.md --task docs/task.md
```

`npm run` starts in the AgenticOS folder, so set `GATE_ROOT` to the checked-out project when using this form.

Start with the findings as a report on the pull request. Make the job block merges only after the team has seen how
often a finding is wrong: these are checks over wording, and some findings need only an explanation.

## What a clean result means

The wording agrees with the sources in the ways the checks look for. It does not show the requirements are right or
complete. Source documents with no headings are named as not checked item by item.
