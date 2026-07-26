I'll research the codebase and organisational standards thoroughly before writing the ADR. Let me run several discovery steps in parallel.Good. Now let me search the codebase for the actual middleware, logging, and gin patterns in use.I now have all the evidence I need. Let me compose and save the ADR, strictly following `GLD-TPL-003@1` and `GLD-STD-001@1`.The ADR has been saved. Here is a summary of what was produced and the key evidence behind every claim.

---

## What was researched

| File | Key evidence extracted |
|---|---|
| `gin.go:202, 236, 239, 340–344` | Two constructors (`New` vs `Default`); `Default` attaches `Logger()` + `Recovery()` globally via `Use()`, which also rebuilds 404/405 chains |
| `logger.go:38–59, 62–91, 167–194, 224–314` | `LoggerConfig` struct, `LogFormatter`/`Skipper` types, `defaultLogFormatter`, and the `c.Next()` → write-after-response execution model |
| `context.go:198–206` | `Next()` iterates `c.handlers` — the mechanism the middleware chain rests on |
| `benchmarks_test.go:27–41` | `BenchmarkLoggerMiddleware` and `BenchmarkManyHandlers` confirm the pattern is performance-tested |
| `logger_test.go` (multiple functions) | 14 test cases covering path-skipping, query-string suppression, custom formatters, and `ErrorLogger` |
| `mode.go:42, 45` | `DefaultWriter = os.Stdout`, `DefaultErrorWriter = os.Stderr` — the sink defaults in play |

## Compliance flags raised (GLD-STD-001@1)

| Rule | Status |
|---|---|
| §1.1 Never log secrets/API keys | ⚠️ **Partial** — `SkipQueryString` exists but defaults to `false` |
| §1.2 Log correlation ID on every request | ❌ **Gap** — no trace/request-ID field in `LogFormatterParams`; follow-up action 1 required |
| §1.3 Log WARN+ for human-actionable events | ✅ Met via `c.Errors` + `Recovery()` panic logging |
| §4.2 Don't leak internals to callers | ✅ Met — `ErrorTypePrivate` stays in the log, not the response |

The ADR follows the mandatory structure from `GLD-TPL-003@1` and cites `GLD-STD-001@1` per the bank's standards.
