# Findings — multi-language + Golden Repository test run, 26 July 2026

12 public repositories, 12 languages, 7 live agent runs against a seeded Golden Repository.
Raw evidence for every claim below is in this folder (see `README.md`).

---

## Summary

| Area | Result |
|---|---|
| Cloning + indexing | 12 / 12 repos indexed |
| Symbol extraction | 12 / 12 languages return real declarations |
| Golden Repository usage | 6 / 7 cases passed; 1 needs a judgement call (below) |
| Errors during agent runs | none — no tool failure, no truncation, no timeout |
| Defects found | 2, both fixed |

---

## Defect 1 — a whole codebase looked empty if we didn't recognise its build file

**Severity: high.** Hit 2 of 12 repos (17%).

`solution_overview` is the first tool nearly every agent calls to orient itself. It listed
"projects" by looking for build manifests it knew. For **jq** (C, autotools) and **os-lib**
(Scala, Mill) it found none and returned exactly one line:

```
No projects found under source root: ...
```

Nothing else. No file count, no folders. An agent reading that would reasonably conclude the
repository was empty and stop.

The code was in fact **fully indexed the whole time** — `find_symbol` located
`jv_parse` at `src/jv_parse.c:913` in the same repo that "had no projects". Only the
orientation tool was blind.

**Fixed twice over**, because unknown build systems will always exist:

1. Added the missing manifests — autotools (`configure.ac`, `configure.in`, `Makefile.am`),
   Mill (`build.mill`, `build.sc`), Meson, Bazel, plain `Makefile`, and `.vbproj`/`.fsproj`.
2. More importantly, `solution_overview` now **falls back to the indexed source layout**
   when it recognises no manifest, and states explicitly that the code is indexed and the
   other tools work. A repo can no longer look empty just because its build system is unfamiliar.

Evidence: `overview-jq-c.txt` (before) vs `overview-jq-c-AFTERFIX.txt` (after — 2 projects, 57 files).

## Defect 2 — the first tool call on a large repo could time out

**Severity: medium.** Hit the largest repo tested (nopCommerce, 3,901 files).

The MCP client used the SDK's default 60-second per-call timeout. Indexing a large repo for
the first time exceeds that, so the agent's opening move returned
`MCP error -32001: Request timed out`. Worse, the existing index warm-up swallowed the same
failure silently, so nothing in the logs explained it.

**Fixed:** the per-call budget is now `MCP_TIMEOUT_MS` (default 10 minutes), applied to both
the warm-up and real tool calls, and a warm-up failure is now logged loudly with the remedy.

*Honest caveat:* the post-fix re-test indexed in 4s, but on a warm OS file cache — so that
number does not by itself prove the fix. What is proven is that the cap is no longer 60s and
the failure is no longer silent.

---

## Language coverage — verified, not assumed

Each row is a real public repo, cloned fresh, with a known symbol looked up. A HIT means the
parser produced an actual declaration with file and line.

| Language | Repository | Files indexed | Symbol found |
|---|---|---|---|
| C# | nopSolutions/nopCommerce | 3,901 | `ShoppingCartController` — class |
| Java | spring-projects/spring-petclinic | 49 | `OwnerController` — class |
| Python | pallets/flask | 84 | `Flask` — class, `src/flask/app.py:109` |
| TypeScript | gothinkster/angular-realworld-example-app | 50 | `ArticlesService` — class |
| JavaScript | gothinkster/react-redux-realworld-example-app | 38 | `ArticleList` — function |
| Go | gin-gonic/gin | 99 | `RouterGroup` — type |
| Ruby | sinatra/sinatra | 147 | `Sinatra` — module |
| PHP | slimphp/Slim | 125 | `App` — class |
| Rust | tokio-rs/mini-redis | 26 | `Connection` — struct |
| C | jqlang/jq | 57 | `jv_parse` — function |
| C++ | nlohmann/json | 505 | `json_pointer` — function |
| Scala | com-lihaoyi/os-lib | 65 | `Path` — object |

One lookup initially reported MISS (`ArticleService` in the Angular app). That was a mistake in
the test, not the platform — the class is `ArticlesService`, plural. Re-run: HIT. Noted because
it is exactly the kind of thing that silently becomes a false bug report.

Also confirmed: asking for a symbol that genuinely does not exist (`AuthGuard`, absent from that
repo) returns "No declarations found" rather than inventing one.

---

## Golden Repository — do the agents actually use it?

A case passes only if the agent **opened** the item with `golden_read`. Naming a document from
its catalog line is not enough.

| Case | Repo / language | Agent | Should pull in | Result |
|---|---|---|---|---|
| C1 | petclinic / Java | Code Reviewer | Secure Coding Standard | **PASS** — read + cited `GLD-STD-001@1` |
| C2 | flask / Python | Config & Secrets Auditor | Secure Coding Standard | **PASS** |
| C3 | gin / Go | Architecture / ADR | ADR template (bound) | **PASS** — output follows the template exactly |
| C4 | angular-realworld / TS | Frontend Architecture | Pre-Release Checklist | **PASS** |
| C5 | Slim / PHP | Reliability Auditor | Triage **Skill** | **PASS** |
| C6 | petclinic / Java | Requirements / BRD | Glossary **via alias** | **PASS** |
| C7 | mini-redis / Rust | Dependency Health | *(nothing — negative control)* | **REVIEW** |

**C3 is the strongest result.** The ADR template is bound to that agent. The saved artifact came
back with the template's exact section structure — Status, Context, Decision, Consequences
(Positive / Negative / Risks we are accepting), Alternatives considered, Compliance. The agent
read the template first, unprompted.

**C6 validates the alias work.** The task asked about a "statutory levy". The word *levy* was
registered as an alias on the glossary. The agent found and opened the glossary — and got the
bank's actual definition (a `Charge` with `ChargeType.Statutory`, explicitly *not* a fee)
rather than the ordinary English meaning.

**C7 is a flaw in my test, and a real design question for you.**
The Secure Coding Standard is *mandatory* and scoped to `all`, so by the platform's own rules
the agent was **right** to read it — there is no such thing as an irrelevant mandatory-for-all
item. My "negative control" was impossible to pass.

But it exposes something worth deciding: **a mandatory `all` item is read on 100% of runs**,
including a Rust dependency audit where it had little to say. The citation it produced was a
trailing parenthetical — "*(GLD-STD-001@1 applied for secrets/logging surface review.)*" —
which is close to ritual. That costs tokens on every run and, more importantly, trains readers
to skim past citations.

**Recommendation:** scope mandatory items with `appliesTo` or tags rather than `all`, unless the
rule genuinely applies to every deliverable. Keep `all` for things like a secure-coding standard
only if you accept it will be read every time.

---

## Still not proven

The **template gate's blocking branch**. Across every run in this session and the previous one,
agents read their bound template *before* saving, so `save_artifact` was never actually refused
(`blocked=no` in all runs). The binding demonstrably works; the platform-level refusal that
backs it up has still never been observed firing. It is defence for the case where a model does
not comply, and no model has yet failed to comply.
