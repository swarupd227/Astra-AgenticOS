Good. I have the standards. Now let me scan the codebase and read key source files.I now have a thorough picture of the codebase. Let me compile the full findings and save the artifact.## Logging Risk Review — Gin Go Service

Standards applied: **`GLD-STD-009@1`** (OWASP Logging Cheat Sheet — mandatory) · **`GLD-STD-003@1`** (Uber Go Style Guide — mandatory). Both standards were read in full before findings were applied.

Semgrep was unavailable on this server; all findings are **Observed** (read directly in code, with `file:line` citations) or labelled **Inferred** where noted.

---

### Seven risks found across 4 files

| ID | Severity | Finding | Evidence |
|----|----------|---------|----------|
| **L-01** | 🔴 High | **Query strings logged by default.** `SkipQueryString` defaults to `false`, so every API key, OAuth code, or password passed as a query parameter is written to every log line verbatim. | `logger.go:279`, `logger.go:306-310` |
| **L-02** | 🔴 High | **`c.Keys` context bag exposed in `LogFormatterParams`.** The entire per-request key/value store (which handlers freely populate with JWT claims, account numbers, etc.) is passed to every formatter with no field-level redaction or access control. | `logger.go:90`, `logger.go:292` |
| **L-03** | 🔴 High | **Authentication failures never logged.** `BasicAuthForRealm` silently aborts with HTTP 401 and writes nothing to any log stream. GLD-STD-009@1 explicitly mandates logging auth failures to detect brute-force and credential-stuffing. | `auth.go:57-60` |
| **L-04** | 🟡 Medium | **Log injection via unsanitised path / error message.** `param.Path` (client-controlled) and `param.ErrorMessage` are interpolated into the format string with no CR/LF or delimiter sanitisation, allowing an attacker to forge log lines. | `logger.go:185-193` |
| **L-05** | 🟡 Medium | **Missing mandatory event attributes.** Every log line lacks: application identifier, trace/correlation ID, and severity level — all required by GLD-STD-009@1 §"Event attributes". Without a trace ID, cross-correlating an access log entry with a panic-recovery entry is impossible. | `logger.go:185-193` |
| **L-06** | 🟡 Medium | **Incomplete header masking in panic recovery.** `secureRequestDump` masks only `Authorization` (exact-case string prefix). `Proxy-Authorization`, `Cookie`, `X-Api-Key`, `X-Auth-Token`, and any credential-bearing custom headers are dumped verbatim in panic log lines. | `recovery.go:98-107` |
| **L-07** | 🟢 Low | **Mixed logging implementation.** The recovery path uses `*log.Logger` (stdlib, with hardcoded ANSI colour escapes) while the rest of the framework writes via `fmt.Fprint(io.Writer)`. Inconsistent implementations make SIEM ingestion unreliable; GLD-STD-003@1 requires a single consistent approach. | `recovery.go:54-56` |

---

### Prioritised mitigations (in order)

1. **L-03 — Log auth failures now.** Add a log call immediately before `c.AbortWithStatus(http.StatusUnauthorized)` in `auth.go:59`. Must fire in both debug *and* release mode. Include: timestamp, client IP, HTTP method, path. **Do not** include the credential.

2. **L-01 — Flip `SkipQueryString` default to `true`.** Change the zero-value behaviour in `logger.go:54` so callers opt *in* to query-string logging rather than opt out. This is a breaking change — a deprecation notice is needed.

3. **L-06 — Expand and case-insensitive-ify header masking.** Replace `strings.HasPrefix(line, "Authorization:")` with a configurable deny-list checked via `strings.EqualFold`. Add at minimum: `Proxy-Authorization`, `Cookie`, `X-Api-Key`, `X-Auth-Token`.

4. **L-04 — Sanitise CR/LF before formatting.** Introduce a `sanitizeLogField(s string) string` helper that strips or replaces `\r`, `\n`, and non-printable bytes. Apply it to `param.Path` and `param.ErrorMessage` before the `fmt.Sprintf` at `logger.go:185`.

5. **L-05 — Add trace ID, app name, and severity.** Extend `LogFormatterParams` with `AppName`, `AppVersion`, and `TraceID` fields. Populate `TraceID` from an incoming `X-Request-ID` header (generate if absent; echo in responses). Consider adopting `go.uber.org/zap` for structured JSON output to satisfy all three gaps at once.

6. **L-02 — Remove or restrict `Keys` from `LogFormatterParams`.** Replace the raw `c.Keys map[any]any` field with an explicit `SafeLogFields map[string]string` that handlers must deliberately populate with pre-sanitised values.

7. **L-07 — Replace stdlib `log.Logger` in recovery.** Swap `recovery.go:54-56` to use `fmt.Fprintf(out, …)` directly (consistent with `debug.go:69` and `logger.go:312`), guarding ANSI colour codes behind the same `IsOutputColor()` check the access logger already uses.

---

### Residual risks & open questions

- **TLS not verified (Unverified).** Basic Auth credentials are base64-encoded in headers. No server TLS configuration was found in the indexed codebase. Confirm with the infrastructure team that TLS is enforced on all routes using `BasicAuth`.
- **`ginMode` defaults to `debugCode` (Observed, `mode.go:48`).** Unless `GIN_MODE=release` is set in the environment, full debug logging (route tables, stack traces) is active. Verify against the production deployment configuration.
- **Log storage protection, retention, and disposal (Inferred/Unverified).** No log-shipping config, file rotation, tamper detection, or retention policy was visible in the codebase. GLD-STD-009@1 §§ "Protection" and "Disposal of logs" require these controls to exist — verify with the infrastructure and compliance teams.

The full findings with all code citations have been saved to **`artifacts/gin-go-37ab71/logging-risk-review-gin.md`** for security reviewer sign-off.
