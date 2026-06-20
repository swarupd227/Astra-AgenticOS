# Design — SDLC Agents for GitHub Copilot

## The idea

Give an engineering team a set of **SDLC agents** they invoke from **GitHub Copilot** inside VS
Code. Each agent is a focused persona (business analyst, impact analyst, architect, test
engineer, reviewer). What makes them trustworthy — instead of plausible-sounding guesses — is
that they are **grounded in the real codebase** through a Model Context Protocol (MCP) server we
provide.

For this demo the codebase is [nopCommerce 3.90](https://github.com/nopSolutions/nopCommerce) —
**ASP.NET MVC 5 on .NET Framework 4.5.1**, the same era and shape as CommerzBank's stack — so the
value translates directly.

## Three layers

```
GitHub Copilot (VS Code)        the LLM + chat UI; runs the selected agent
        │  reads agent persona + allowed tools
Copilot Custom Agents           5 SDLC personas  (.github/agents/*.agent.md)
        │  call tools over MCP (stdio)
SDLC MCP Server (C# / .NET 9)   grounded code intelligence over the source tree
```

- **Copilot** supplies the reasoning and the chat experience.
- **Custom agents** (plain Markdown + frontmatter) supply the *persona, workflow, and output
  format*. Reused from [github/awesome-copilot](https://github.com/github/awesome-copilot) where a
  good base existed, then adapted.
- **The MCP server** (our C# code) supplies *facts*: real declarations, a real reference graph,
  real file contents. This is what turns "impact analysis" from hand-waving into a defensible
  report.

This split mirrors awesome-copilot's own `cast-imaging-impact-analysis` agent, which is backed by
the **commercial** CAST Imaging cloud. We replace that with a **free, local, Roslyn-based** server
— no data leaves the machine, which matters for a bank.

## Why C# for the MCP server

The audience lives in .NET. The server is built with the official
[`ModelContextProtocol`](https://www.nuget.org/packages/ModelContextProtocol) C# SDK, so it's
"built in your stack." It runs on .NET 9 and uses **Roslyn** (`Microsoft.CodeAnalysis.CSharp`) to
parse the .NET Framework 4.5.1 source as syntax trees. It **analyses** the legacy code without
needing to **build** it — robust, fast, no toolchain dependency.

### MCP tools exposed

| Tool | What it does |
|------|--------------|
| `solution_overview` | Map projects by layer (Libraries / Presentation / Plugins / Tests) |
| `find_symbol` | Where a type/method/property is declared (file:line, signature) |
| `search_code` | Substring / regex search across all C# files |
| `read_file` | Source of a file or line range, with line numbers |
| `find_references` | Candidate usages of a symbol across the codebase |
| `analyze_impact` | Structured blast-radius: dependents by layer, risk rating, suggested tests |
| `save_artifact` | Persist a BRD / ADR / test / review into `/artifacts` |
| `list_artifacts` | List generated deliverables |

`analyze_impact` automatically treats a class and its `I`-prefixed interface as one component
(e.g. `TaxService` ⇄ `ITaxService`), because in a DI codebase the real dependency surface is the
interface.

## The 28 agents

| Agent | Demo value | Reuse base (awesome-copilot) |
|-------|-----------|------------------------------|
| **Requirements / BRD** | Recover a BRD from undocumented legacy code in minutes | `prd` + `specification` |
| **Impact Analysis** | "What breaks if I change this?" — grounded ripple analysis | `cast-imaging-impact-analysis` (pattern) |
| **Architecture / ADR** | Document architecture + record decisions | `adr-generator` + `system-architecture-reviewer` |
| **Test Generation** | NUnit tests matching the team's conventions | `expert-dotnet-software-engineer` |
| **Code Review** | .NET Framework + security review with citations | `security-reviewer` + `code-review-generic` |
| **Modernization (.NET 10)** | Migration-blocker inventory + phased .NET 10 roadmap (Strangler Fig) | new (legacy-modernization pattern) |
| **Refactor** | Duplication / code-smell finder with safe before/after, scoped by callers | `refactor` patterns |
| **Test Coverage / Gaps** | Untested high-risk code, ranked by usage; feeds Test Generation | new |
| **Traceability (Spec ↔ Code)** | Requirements→code→test matrix; flags gaps + orphans (audit) | new |
| **Data Model** | ERD/schema recovered from EF entities + mappings | new |
| **API Contract** | OpenAPI 3 recovered from controllers + DTOs | new |
| **Code Generation** | Spec-grounded code in the team's conventions (proposal) | `expert-dotnet-software-engineer` |
| **Security / Threat Model** | STRIDE threat model grounded in code | `security-reviewer` (pattern) |
| **Orchestrator** | Plans + **delegates to the other agents** + synthesises | new (multi-agent) |
| **CI/CD Pipeline** | Framework-aware GitHub Actions / Azure DevOps pipeline | new (Ops) |
| **Observability & Rollback** | Golden signals + rollback runbook for a deploy | new (Ops) |
| **Dependency Mapper** | Project + NuGet graph, layering violations, stale packages | new (Memory & Context) |
| **Spec Validator** | Spec/BRD completeness, ambiguity, testability vs code | new (Spec quality gate) |
| **Regression** | Risk of a git diff (working tree / commit / range) via the impact graph | new (QA) |
| **Changelog** | Categorized release notes from git history | new (Memory & Context) |
| **Human Review (HITL Gate)** | Go/no-go review packet: checklist, risk tier, sign-offs, escalation | new (governance) |

The last three are backed by a **git** tool group on the MCP server (`git_status` / `git_log` /
`git_diff` / `git_show`), so they reason about *what actually changed*, not just the current snapshot.

| **Dead Code & Cleanup** | Unreferenced members/files (with DI/reflection caveats) | new (brownfield) |
| **Characterization Tests** | Golden-master tests pinning current behavior of legacy code | new (brownfield) |
| **Config & Secrets Auditor** | Secrets / connection strings / insecure settings in config | new (brownfield) |
| **Tech-Debt Hotspot Prioritizer** | Churn × complexity × coupling → what to fix first | new (brownfield) |

The brownfield set is tuned for legacy reality: Dead Code is honest about *invisible* .NET usage
(DI, reflection, MVC routing); Characterization Tests pin *current* (not intended) behavior so
refactors are safe; the Config Auditor leans on the project/config-file indexing; and the Hotspot
Prioritizer uses git churn to rank where debt actually hurts.

| **Reliability & Error Handling** | Swallowed exceptions, broad catches, lost stack traces, async void | new (Code Health) |
| **Async & Performance** | Sync-over-async, N+1 queries, blocking I/O, allocation hotspots | new (Code Health) |
| **Data-Access Risk** | SQL injection (concatenated SQL) + EF anti-patterns | new (Code Health) |

The Code Health auditors are pattern-sweep + confirm: they `search_code` (regex) for the anti-pattern,
then `read_file` to confirm it's real before flagging — and they explicitly *don't* false-flag the
safe form (a parameterised query, a log-and-rethrow catch, a `.Result` in startup code).

Agents 6–13 were added with **no new MCP server code** — they compose the existing Roslyn-backed
tools (new SDLC capabilities = new persona files, not new infrastructure). The **Orchestrator** is
the one exception: it adds an *agent-runs-agents* delegation layer in the UI backend — a synthetic
`delegate(agent, task)` tool that runs another agent's loop, streams its work nested in the UI, and
returns its result for the Orchestrator to chain and synthesise.

Shared `.github/instructions/*.instructions.md` (reused verbatim, MIT) auto-apply .NET Framework
and C# standards whenever Copilot edits `*.cs` / `*.csproj`.

## Grounding contract (why the output is trustworthy)

Every agent is instructed to: use the MCP tools to read real code, **cite `file.cs:line`** for
each claim, and flag ambiguities instead of inventing. References are syntactic candidate matches,
clearly labelled, with `read_file` available to confirm precision.

## Client-agnostic by design

The same MCP server works in **Claude Desktop / Claude Code** or any MCP client — a ready fallback
if Copilot licensing isn't available on demo day, and proof the approach isn't locked to one tool.

## Roadmap (phase 2 talking points)

- Semantic analysis via `MSBuildWorkspace` for exact (not candidate) references.
- More agents from the SDLC slide: CI/CD, monitoring, rollback, changelog/dependency mapping,
  and an orchestrator that chains them.
- Write-back: agents open PRs with generated tests/refactors behind a human-review gate.
- Point the MCP server at a CommerzBank repository instead of nopCommerce.
