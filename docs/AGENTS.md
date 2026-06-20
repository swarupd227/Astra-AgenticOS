# ASTRA AgenticOS — the 28 agents

Each agent is a specialist you invoke from the UI (or GitHub Copilot). They all read the **real
code** through the same MCP server, so every answer is grounded in your codebase — not guessed, and
cited to `file.cs:line`.

## Orchestration
1. **Orchestrator** — Give it a high-level goal; it plans which specialist agents to run, runs them, and merges the results into one report.
   It genuinely *delegates* — calling the other agents, feeding each one's output into the next, resolving conflicts, and writing a single consolidated recommendation.

## Requirements & Analysis
2. **Requirements / BRD** — Reads existing code and writes the business rules it follows, in plain language.
   Recovers a full Business Requirements Document for an undocumented feature, with every rule traced back to the code it came from.
3. **Impact Analysis** — Tells you what could break if you change a class or method, and what to re-test.
   Uses the real reference graph (and pairs a class with its interface) to rate risk and list dependents by layer — a free, local alternative to tools like CAST Imaging.
4. **Traceability** — Maps each requirement to the code that implements it and the tests that verify it.
   Flags requirements with no implementation and code with no governing requirement — the evidence auditors and regulators ask for.
5. **Spec Validator** — Reviews a spec/BRD for gaps, ambiguity and testability.
   Cross-checks each requirement against the actual code and flags where the spec and the implementation disagree.

## Design
6. **Architecture / ADR** — Documents the system's architecture and records design decisions.
   Produces a layered overview (DI, plugins, caching patterns) and proper ADRs (context / options / decision / consequences) for a proposed change.
7. **Data Model** — Recovers the database design (tables, keys, relationships) from the code as an ERD.
   Reads the EF entities and mapping classes directly and renders a Mermaid ER diagram plus a written schema reference.
8. **API Contract** — Generates an OpenAPI spec from the controllers.
   Reads action signatures, routes and DTOs into a Swagger/Postman-ready contract, honestly flagging where MVC actions return views rather than typed payloads.

## Implementation
9. **Code Generation** — Implements a requested change in the codebase's own style, as a reviewable proposal.
   Studies a sibling service, its interface, DI registration and tests first so the code fits in — and never edits the repo directly.
10. **Refactor** — Proposes safe, behaviour-preserving cleanups of duplication and messy code.
    Scopes every change by who actually calls it (find-references) and gives before/after snippets so reviewers can act with confidence.

## Quality & Testing
11. **Test Generation** — Writes unit tests (NUnit) that match the team's existing style.
    Mirrors an existing fixture's conventions (mocks, AAA, naming) so the generated tests look hand-written by the team.
12. **Test Coverage / Gaps** — Finds untested high-risk code and ranks what to test first.
    Compares each type's public surface to the tests that exist and weights the gaps by how widely the code is used.
13. **Code Review** — Reviews code for correctness and security with .NET best practices.
    Returns prioritised findings (Blocker→Low) with `file:line` and concrete fixes, applying the reused .NET + security standards.
14. **Regression** — Reads your actual changes (git diff) and predicts what might break.
    Identifies the changed symbols, traces their callers, and produces a targeted re-test plan and a merge recommendation.
15. **Dead Code & Cleanup** — Finds unused code and orphaned files safe to remove.
    Accounts for *invisible* .NET usage (DI, reflection, MVC routing) and reports candidates with a confidence level instead of deleting blindly.
16. **Characterization Tests** — Writes "golden-master" tests that lock in current behaviour so you can refactor safely.
    Pins what the code does *today* (not what it should do) and flags any behaviour that looks like a latent bug to confirm before changing.

## Code Health
17. **Reliability & Error Handling** — Finds swallowed exceptions and missing logging that cause silent failures.
    Sweeps for empty/over-broad catches and stack-destroying `throw ex;`, ranks them by risk, and gives the fix.
18. **Async & Performance** — Finds performance and concurrency problems like blocking calls and N+1 queries.
    Catches sync-over-async (`.Result`/`.Wait()`) that can deadlock ASP.NET, and per-iteration database calls, with the impact and remedy.
19. **Data-Access Risk** — Finds SQL-injection risks and inefficient query patterns.
    Distinguishes dangerous concatenated SQL from safe parameterised queries (no false alarms) and flags EF anti-patterns (missing `AsNoTracking`, unbounded queries).

## Security
20. **Security / Threat Model** — Builds a STRIDE threat model for a feature, with risks and fixes.
    Traces the real data flow and trust boundaries (user → app → DB → payment gateway) and rates each threat for a banking context.
21. **Config & Secrets Auditor** — Scans config files for hardcoded secrets, passwords and insecure settings.
    Reads `web.config`/`app.config`/`appsettings` directly and flags Critical items like plaintext credentials and `debug="true"`, with a remediation plan.

## Ops & Delivery
22. **CI/CD Pipeline** — Generates a build/test/deploy pipeline matched to the project's real build system.
    Detects classic MSBuild vs SDK-style and emits the correct toolchain (Windows + NuGet + MSBuild + VSTest for .NET Framework), not a generic template.
23. **Observability & Rollback** — Produces what to monitor (health checks, alerts) and a step-by-step rollback plan for a release.
    Picks signals that match the app's real risks (order success, payment latency) and writes a runbook with revert steps and recovery checks.

## Modernization
24. **Modernization (.NET 10)** — Assesses what's blocking a .NET 10 upgrade and gives a phased migration roadmap.
    Inventories real blockers (System.Web, Global.asax, EF6, web.config…) with `file:line` and a Strangler-Fig sequence that de-risks the data layer first.

## Memory & Context
25. **Dependency Mapper** — Maps project and NuGet dependencies; flags layering violations and stale packages.
    Reads the `.csproj`/`packages.config` directly to draw the dependency graph and call out risky/abandoned libraries (EOL EF6, AGPL iTextSharp…).
26. **Changelog** — Turns git history into readable release notes, grouped by type.
    Reads commits (and their diffs when terse) into Keep-a-Changelog style notes a stakeholder can read, flagging breaking changes.
27. **Tech-Debt Hotspot Prioritizer** — Ranks the riskiest files so you know where to start.
    Combines git churn with complexity and coupling, and pairs each hotspot with a safe first step (characterization tests, then refactor).

## Human Review
28. **Human Review (HITL Gate)** — Assembles a go/no-go approval pack for a human to approve before anything ships.
    Pulls together the produced artifacts, assigns a risk tier, and lists the checklist, required sign-offs and escalation triggers — treating missing evidence (no tests, no threat model) as a gate failure.

---

## What we built specifically for this engagement (not off-the-shelf)

1. **Build-free Roslyn MCP server.** We index legacy **.NET Framework 4.x** source *syntactically* — no compilation needed — so it works on code that won't build in a modern toolchain. This is what makes grounding on a real brownfield estate possible.
2. **Project / config / git–aware grounding.** `read_file` and `search_code` cover `.cs` **and** `.csproj`, `packages.config`, `web.config`, `.sln`, plus a **git tool group** (`status`/`log`/`diff`/`show`). That's why the Ops, Dependency, Config, Regression and Changelog agents are real, not theoretical.
3. **A true multi-agent Orchestrator.** An agent that actually *delegates to other agents* and synthesises their output — streamed as nested cards in the UI. Most "orchestrators" only produce a plan; ours runs the team.
4. **One agent set, multiple hosts.** The same persona files run in **GitHub Copilot** (the team's daily tool) **and** in our standalone **ASTRA** browser UI — and in any MCP client (Claude, etc.). Client-agnostic by design.
5. **ASTRA AgenticOS UI.** Point it at **any local folder or git repo** (clone + index), agents **grouped by SDLC area**, live token streaming, nested delegation visualization, an **artifacts browser** (view + download), light/dark, and first-run onboarding.
6. **Brownfield-first behaviour.** Agents tuned for legacy reality: Dead Code respects DI/reflection/MVC-routing; Data-Access never false-flags parameterised SQL; Characterization Tests pin *current* behaviour; CI/CD detects MSBuild vs SDK.
7. **A grounding contract for a regulated environment.** Every claim cites `file.cs:line`; references are labelled as syntactic *candidates*; agents are instructed to flag ambiguity rather than invent.
8. **Reuse over reinvention.** Agent personas and the .NET/security coding standards are adapted from the open **github/awesome-copilot** library — we assembled and *grounded* them rather than writing from scratch.
9. **Demo-grade reliability.** Transient-error retry with mid-stream recovery, tuned token/turn budgets, and framework-aware output — so it holds up live.
10. **Coverage.** 28 agents spanning the **entire SDLC slide** plus a dedicated **Code Health + brownfield** toolkit beyond it — pointable at a CommerzBank repo with zero agent changes.
