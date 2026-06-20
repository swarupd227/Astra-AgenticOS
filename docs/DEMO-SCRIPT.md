# Demo Script — SDLC Agents for GitHub Copilot

A ~15-minute walkthrough for CommerzBank. The story: **legacy .NET Framework code, no docs, scary
to change** → agents that read the real code and make the team faster and safer.

## 0. Setup (before the room)

```powershell
./scripts/setup.ps1          # clones nopCommerce 3.90 + builds the MCP server (Release)
```
- Open the `AgenticOS` folder in **VS Code**.
- Open **Copilot Chat**. VS Code reads `.vscode/mcp.json` and offers to start the **sdlc-agents**
  MCP server — start it. (Confirm via the "Tools" / wrench icon that `analyze_impact`,
  `find_references`, etc. are listed.)
- The agents appear in the chat **agent picker** (from `.github/agents/`).
- One-liner to open with: *"This is nopCommerce — ~1,700 C# files of ASP.NET MVC on .NET
  Framework 4.5.1. Same shape as our systems. Nobody on the team wrote the docs. Watch."*

> The first agent call that touches code triggers a one-time Roslyn index (~a few seconds). Do a
> throwaway `solution_overview` call before the demo to warm it up.

---

## 1. Orientation (1 min) — show the grounding is real

**Agent:** Architecture / ADR → **Mode A**
**Prompt:**
> Give me an architecture overview of this solution.

Expect: layers (Libraries / Presentation / Plugins / Tests), DI/plugin patterns, each with
`file.cs:line` citations. Point out: *"it's reading the actual projects, not guessing."*

---

## 2. ⭐ Requirements / BRD from legacy code (4 min) — the flagship

**Agent:** Requirements / BRD Generator
**Prompt:**
> Generate a Business Requirements Document for the **shopping cart / checkout tax calculation**.
> Focus on the business rules in the tax and order-total services.

What happens: it runs `search_code` / `find_symbol`, reads `TaxService.cs` and
`OrderTotalCalculationService.cs`, extracts business rules into business language, and
`save_artifact`s `brd-checkout-tax.md` into `/artifacts`.

Talking point: *"This is the document that didn't exist this morning — every rule cites the line
of code it came from, so an analyst, a developer, and an auditor can all trust it."* Open the saved
file from `/artifacts`.

---

## 3. ⭐ Impact Analysis (4 min) — the "wow"

**Agent:** Impact Analysis
**Prompt:**
> I need to change how tax is calculated — specifically `TaxService`. What is the blast radius and
> what must I re-test?

Expect (grounded, from the real reference graph):
- Treats `TaxService` **and** `ITaxService` as one component.
- ~**22 dependent files / ~45 references**, risk **MEDIUM**.
- Dependents by layer: **Controllers** (Customer, ShoppingCart, Order…), **Services**
  (OrderTotalCalculation, OrderProcessing…), **Plugins** (PayPal Direct/Standard, Google
  Shopping), **Tests**.
- A regression plan naming the existing `*Tests.cs` to run first.

Talking points:
- *"Notice it followed the interface — that's where the real coupling is in a DI system."*
- *"It found the **PayPal** plugins depend on tax — exactly the kind of cross-module surprise that
  causes incidents in a bank."*
- *"This is a free, local replacement for a tool like CAST Imaging — nothing leaves the machine."*

Optional drill-down:
> Open `OrderTotalCalculationService.cs` where it uses tax and explain how a signature change would
> affect it.

---

## 4. Test Generation (3 min)

**Agent:** Test Generator
**Prompt:**
> Write NUnit tests for `OrderTotalCalculationService`, matching the style of the existing tests in
> `Tests/Nop.Services.Tests`.

Expect: it reads the implementation **and** an existing sibling test, then generates a
convention-matching NUnit test class (existing fakes, AAA, descriptive names) and saves it to
`/artifacts/tests/`. Talking point: *"Closes the coverage gap the impact analysis just flagged —
in the team's own test style, not a generic one."*

---

## 5. Code Review (2 min)

**Agent:** Code Reviewer (.NET Framework + Security)
**Prompt:**
> Review `Libraries/Nop.Services/Tax/TaxService.cs` for correctness and security issues.

Expect: prioritised findings (BLOCKER→LOW) with `file.cs:line`, risk, and concrete fixes, applying
the .NET Framework + security standards from `.github/instructions/`.

---

## 6. (Optional) ADR (1 min)

**Agent:** Architecture / ADR → **Mode B**
**Prompt:**
> We want to move tax calculation behind a strategy pattern so we can plug in per-region rules.
> Write an ADR, and use the impact analysis for the consequences.

Expect: a proper ADR (context / options / decision / consequences) with the blast radius grounded
in `analyze_impact`, saved to `/artifacts`.

---

## 7. ⭐ Modernization → .NET 10 (3 min) — the strategic close

**Agent:** Modernization (.NET 10)
**Prompt:**
> Assess this solution for migration to **.NET 10**. Inventory the migration blockers, score the
> effort, and give me a phased roadmap.

What happens: it profiles the solution, then `search_code`s every blocker category (`System.Web`,
`Global.asax`, EF6, `FormsAuthentication`, `AppDomain` plugin restart, `ConfigurationManager`,
bundling…), `read_file`s the top hits to confirm, runs `analyze_impact` on the load-bearing legacy
types, and `save_artifact`s a full assessment with a **Strangler-Fig** roadmap (phases, weeks, exit
criteria).

Talking points:
- *"This is the board-level question — 'how do we get off unsupported .NET Framework?' — answered
  from the actual code, with every blocker citing `file.cs:line`, not a generic checklist."*
- *"It targets **.NET 10**, the current LTS, and sequences the work to deliver value early and
  de-risk the data layer first."*

---

## 8. More agents (run any as time allows)

| Agent | Prompt | What lands |
|-------|--------|-----------|
| **Refactor** | "Find duplication and code smells in `OrderTotalCalculationService` and propose safe refactors with before/after." | Behaviour-preserving refactors, each scoped by its real callers |
| **Test Coverage / Gaps** | "What isn't tested in `TaxService`? Give me the coverage gaps, risk-ranked by usage." | A prioritised gap list — feeds straight into the Test Generator |
| **Traceability (Spec ↔ Code)** | "Build a requirements-to-code traceability matrix for shopping-cart tax calculation, and flag gaps or orphans." | Req→code→test matrix with status; the audit/regulatory artifact |

*Chaining story:* Impact Analysis → Test Coverage finds the gap → Test Generator fills it →
Traceability proves the requirement is now verified. Same MCP server throughout.

---

## Close (1 min)

- **Reuse:** agents adapted from the open `github/awesome-copilot` library; standards reused
  verbatim — we're not reinventing, we're assembling + grounding.
- **Grounded:** every answer cites real code via our MCP server.
- **Yours next:** point the same MCP server at a CommerzBank repo — zero agent changes.
- **Roadmap:** more SDLC agents (CI/CD, monitoring, rollback), exact semantic references, and
  PR write-back behind a human-review gate.

## Alternative driver — the visual UI (browser)

Instead of (or alongside) VS Code, run the **browser chat app** in [`ui/`](../ui/):

```bash
cd ui && npm install
$env:ANTHROPIC_API_KEY = "sk-ant-..."   # PowerShell
npm start                                # → http://localhost:5173
```

Same agents, same MCP server, same grounding — just a browser host driven by the Claude API, with
tool calls shown live. Great when you want a clean, self-contained screen without the VS Code
chrome, or when the audience isn't familiar with VS Code. The same numbered prompts above work
verbatim (they're preloaded as suggested-prompt chips per agent).

## Fallback (if Copilot is unavailable)

Register `src/SdlcAgents.Mcp` in **Claude Desktop/Code** (`command: dotnet`, arg: the built DLL,
same env vars) and run the identical prompts — proves the design is client-agnostic.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Agents don't appear | Confirm files exist in `.github/agents/`; reload VS Code window. |
| Tools not available to agent | Start the `sdlc-agents` server in Copilot's tools panel; check `.vscode/mcp.json` paths. |
| Server won't start | Run `./scripts/setup.ps1` to build Release; verify `bin/Release/net9.0/SdlcAgents.Mcp.dll` exists. |
| Empty/odd results | Ensure `NOPCOMMERCE_ROOT` points at `demo/nopCommerce/src`. |
