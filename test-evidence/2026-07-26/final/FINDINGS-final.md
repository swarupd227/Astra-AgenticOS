# Final acceptance test — real published guidelines, 26 July 2026

Nine genuine engineering standards taken from public GitHub repositories, loaded into the
Golden Repository, scoped per project by tag, and exercised by four different agents across
eight languages.

Everything here is reproducible: `load-real-guides.ps1` then `run-final.ps1`, with the
complete event stream of every run in `runs/`.

## Result: 9 / 9 passed, no errors

| Case | Repo (language) | Agent | Guide it should use | Size | Time | Result |
|---|---|---|---|---|---|---|
| R1 | gin (Go) | Code Reviewer | Uber Go Style Guide | 89 KB | 230s | PASS |
| R2 | Flask (Python) | Code Reviewer | PEP 8 | 50 KB | 149s | PASS |
| R3 | Slim (PHP) | Code Reviewer | PSR-12 | 27 KB | 162s | PASS |
| R4 | Sinatra (Ruby) | Code Reviewer | Ruby Style Guide | 147 KB | 155s | PASS |
| R5 | mini-redis (Rust) | Code Reviewer | Rust API Guidelines | 7 KB | 162s | PASS |
| R6 | react-realworld (JS) | Frontend Architecture | Airbnb JavaScript | 130 KB | 191s | PASS |
| R7 | petclinic (Java) | Config & Secrets Auditor | OWASP Secrets Management | 64 KB | 127s | PASS |
| R8 | gin (Go) | Security / Threat Model | OWASP Logging | 29 KB | 178s | PASS |
| R9 | angular-realworld (TS) | Code Reviewer | *(none — isolation trap)* | — | 210s | PASS |

Every run cited what it read as `id@version`. No tool errors, no `max_tokens` truncation,
no timeouts — including the two runs that loaded a 147 KB and a 130 KB document.

## Guidelines used

Real, published documents — not written for this test:

| Guide | Source repository |
|---|---|
| Uber Go Style Guide | `uber-go/guide` |
| PSR-12 Extended Coding Style | `php-fig/fig-standards` |
| PEP 8 | `python/peps` |
| Ruby Style Guide | `rubocop/ruby-style-guide` |
| Rust API Guidelines Checklist | `rust-lang/api-guidelines` |
| .NET Runtime C# Coding Style | `dotnet/runtime` |
| Airbnb JavaScript Style Guide | `airbnb/javascript` |
| OWASP Logging Cheat Sheet | `OWASP/CheatSheetSeries` |
| OWASP Secrets Management Cheat Sheet | `OWASP/CheatSheetSeries` |

## Project isolation is enforced by the platform, not by the prompt

Each project was scoped to its own language tag plus the shared `security` tag. Verified
directly at the MCP layer rather than inferred from agent behaviour:

- Go project asked to read PSR-12 → `'GLD-STD-004' is not available to this project.`
- PHP project asked to read PSR-12 → returns the document.

An agent on the Go project cannot reach the PHP standard even if it tries. This matters if
different business areas' standards should not leak across projects.

## The isolation trap (R9)

The Angular project was deliberately given **no** TypeScript guide, then asked to review
"against our organisation's TypeScript coding standard". The agent did not invent one:

> The Golden Repository catalogue contains exactly two items — both mandatory OWASP standards
> (`GLD-STD-009@1`, `GLD-STD-010@1`). No separate org TypeScript style standard exists.

It then applied the two standards it did have, and clearly separated general Angular/TypeScript
best practice from organisational policy. That separation is the point — a reviewer can tell
which findings carry the weight of a bank standard and which are advice.

## The findings are real, and grounded

Spot-checked rather than trusted. R1 (gin, Go) reported that the panic-recovery middleware
writes credential headers into logs, citing OWASP Logging "Data to exclude" and Uber Go's
"Handle Errors Once" at `recovery.go:99`.

Checked against the source. Both parts hold:

- Line 99 is `httpRequest, _ := httputil.DumpRequest(r, false)` — the error is discarded,
  exactly as cited, at exactly that line.
- The function's own comment states: *"Currently, only the Authorization header is sanitized.
  All other headers and request data remain unchanged."* So `Cookie`, `X-Api-Key` and
  `X-Auth-Token` genuinely do reach the log.

R4 (Ruby, the 147 KB guide) quoted specific rules — *"Never rescue `Exception`; rescue
`StandardError` instead"* — rather than generic advice, which means the whole document was
read and used, not skimmed from the catalog description.

## Performance

Runs took 127–230 seconds. The largest documents did not produce the slowest runs (the 147 KB
Ruby guide ran in 155s; the 89 KB Go guide took 230s), so run time is driven by how much code
the agent explores, not by golden document size.

## Nothing failed

No defects were found in this round. The two defects found earlier the same day
(`solution_overview` blind to unfamiliar build systems, and the 60s MCP call timeout) were
already fixed and did not recur — every repo indexed and every first tool call succeeded.
