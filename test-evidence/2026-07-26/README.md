# Platform test evidence — 26 July 2026

Multi-language and Golden Repository verification, run against the local build
(MCP server in `Release`, UI on `localhost:5173`) with real public repositories
cloned fresh from GitHub.

## How to reproduce

```bash
npm --prefix ui start
```

Then, in order:

| Script | What it does |
|---|---|
| `seed-golden.ps1` | Creates 5 representative Golden Repository items (one per kind, covering all three enforcement levels and both binding styles) |
| `run-repos.ps1` | Clones 11 public repos, indexes each, records `solution_overview` |
| `run-symbols.ps1` | Looks up a known symbol per language — proves the parser extracts declarations, not just file counts |
| `run-golden-agents.ps1` | 7 live agent runs checking whether agents actually *open* the golden items they should |

## Files

| File | Contents |
|---|---|
| `01-golden-seed.log` | The seeded library |
| `02-indexing-sweep.csv` / `.log` | Per-repo clone + index results |
| `overview-<repo>.txt` | Raw `solution_overview` output per repo |
| `overview-<repo>-AFTERFIX.txt` | Same repo after the manifest fix (jq-c, oslib-scala only) |
| `03-symbol-extraction.csv` / `.log` | Symbol lookup per language |
| `symbol-<repo>.txt` | Raw `find_symbol` output |
| `04-golden-agent-runs.csv` / `.log` | Verdict per golden-repo case |
| `runs/<case>-*.ndjson` | Complete event stream of every agent run — every tool call and result |
| `runs/<case>-answer.md` | What the agent finally said |

## Reading the golden-agent verdicts

A case **passes only if the agent called `golden_read` on the expected item.** Mentioning
an item by name is not enough — an agent can name a document from its catalog description
without ever opening it, and the whole point of the feature is that it reads the real text.

`C7` is a deliberate negative control: no golden item is relevant to it. It passes by
*not* citing anything, which is what stops the feature degrading into ritual citation.
