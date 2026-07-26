Good — this is the **Gin web framework** source itself. Let me now read the primary routing and middleware files.Now let me read the remaining supporting files and check for additional patterns:I now have a thorough read of all the primary files. Let me produce the full review.I have everything I need. Let me now compose and save the full review.# Code Review — Routing & Middleware (`gin.go`, `routergroup.go`, `recovery.go`, `logger.go`, `auth.go`, `mode.go`, `debug.go`, `utils.go`)

**Date:** 2026-07-26 | **Standards applied:** `GLD-STD-003@1` · `GLD-STD-009@1` · `GLD-STD-010@1`  
**Semgrep:** unavailable on this server — all findings grounded in direct `read_file`/`search_code` reads; exploitability stated per finding.

---

## Findings (sorted by severity)

---

### [HIGH] Trust-all-proxies is the out-of-the-box default — `gin.go:225`

**Observed:**
```go
trustedProxies: []string{"0.0.0.0/0", "::/0"},
trustedCIDRs:   defaultTrustedCIDRs,   // also 0/0 and ::/0
```
Every engine that never calls `SetTrustedProxies` accepts any `X-Forwarded-For` header as authoritative. The `[WARNING]` emitted in `Run()` is debug-mode-only and doesn't block startup.

**Risk:** IP-based audit logging, rate-limiting, fraud controls, and geo-fencing — all built on `ClientIP()` — can be bypassed by spoofing the forwarded header. Violates `GLD-STD-009@1` §"Who" (log must record the real source address).

**Fix:** Default `trustedProxies` to `nil` (trust nothing). Callers must explicitly opt in via `SetTrustedProxies`. Promote the warning to a hard startup error if the value remains all-zeroes in release mode.

---

### [HIGH] Runtime-triggerable panics from env-var / config input — `mode.go:75`, `routergroup.go:105`, `utils.go:87,107,126,159`

**Observed:** `SetMode` panics on an unknown `GIN_MODE` value; `resolveAddress` panics if `addr` has >1 element; `assert1` is the panic mechanism for all route-registration guards.

Per `GLD-STD-003@1` §"Don't Panic":
> *Code running in production must avoid panics … If an error occurs, the function must return an error and allow the caller to decide how to handle it.*

`SetMode` and `resolveAddress` can be triggered by environment variables — a mis-set `GIN_MODE` or `PORT` crashes the whole process.

**Fix (`SetMode` example):**
```go
func SetMode(value string) error {
    switch value {
    case DebugMode:  ginMode.Store(debugCode)
    case ReleaseMode: ginMode.Store(releaseCode)
    case TestMode:   ginMode.Store(testCode)
    default:
        return fmt.Errorf("gin: unknown mode %q (available: debug, release, test)", value)
    }
    modeName.Store(value)
    return nil
}
```
Route-registration panics (duplicate path, bad wildcard) that fire at `init`/startup time are within the standard's permitted exception for "bad things at program startup."

---

### [HIGH] Raw `int32` used for `ginMode` instead of `atomic.Int32` — `mode.go:48`, `debug.go:23`

**Observed:**
```go
var ginMode int32 = debugCode   // mode.go:48
// ...
atomic.StoreInt32(&ginMode, …)  // SetMode
atomic.LoadInt32(&ginMode, …)   // IsDebugging
```

`GLD-STD-003@1` §"Use go.uber.org/atomic" (or the stdlib equivalent):
> *It is easy to forget to use the atomic operation … raw types leave the door open for a future contributor to read without the atomic accessor.*

Since Go 1.19 the standard library provides `sync/atomic.Int32` with the same safety guarantee as `go.uber.org/atomic`.

**Fix:**
```go
var ginMode atomic.Int32  // zero == debugCode — no explicit init needed

func IsDebugging() bool { return ginMode.Load() == debugCode }
```

---

### [MEDIUM] `secureRequestDump` only redacts `Authorization` — other credential headers logged verbatim — `recovery.go:98-107`

**Observed:**
```go
for i, line := range lines {
    if strings.HasPrefix(line, "Authorization:") {
        lines[i] = "Authorization: *"
    }
}
```
`Cookie`, `Set-Cookie`, `Proxy-Authorization`, `X-Api-Key`, `X-Auth-Token` are all dumped unredacted into the panic log. `GLD-STD-009@1` §"Data to exclude" lists access tokens, session IDs and credentials as items that must never appear in logs directly. `GLD-STD-010@1` §2.8 reinforces this.

Additionally, the error from `httputil.DumpRequest` is silently discarded with `_` (a separate GLD-STD-003@1 §"Handle Errors Once" violation at `recovery.go:99`).

**Fix:**
```go
var _sensitiveHeaders = map[string]struct{}{
    "authorization": {}, "proxy-authorization": {}, "cookie": {},
    "set-cookie": {}, "x-api-key": {}, "x-auth-token": {},
}

func secureRequestDump(r *http.Request) string {
    dump, err := httputil.DumpRequest(r, false)
    if err != nil {
        return fmt.Sprintf("[request dump error: %v]", err)
    }
    lines := strings.Split(bytesconv.BytesToString(dump), "\r\n")
    for i, line := range lines {
        if idx := strings.IndexByte(line, ':'); idx > 0 {
            if _, redact := _sensitiveHeaders[strings.ToLower(strings.TrimSpace(line[:idx]))]; redact {
                lines[i] = line[:idx+1] + " *"
            }
        }
    }
    return strings.Join(lines, "\r\n")
}
```

---

### [MEDIUM] `stack()` has a stale-file / wrong-source-line bug — `recovery.go:135-141`

**Observed:**
```go
if file != lastFile {
    nLine, err = readNthLine(file, line-1)
    if err != nil {
        continue          // lastFile NOT updated — next iteration re-reads same file
    }
    lastFile = file       // only advanced on success
}
fmt.Fprintf(buf, "\t%s: %s\n", function(pc), cmp.Or(nLine, dunno))
// ^ prints stale nLine from the previous file when readNthLine fails
```
When `readNthLine` errors, `lastFile` is not advanced; the next frame in the same file re-enters the `if` block, retries the failing read, and `nLine` from a prior file is printed against the current frame — silently wrong stack source context.

**Fix:**
```go
if file != lastFile {
    lastFile = file   // always advance
    nLine = dunno     // reset
    if n, readErr := readNthLine(file, line-1); readErr == nil {
        nLine = n
    }
}
```

---

### [MEDIUM] Raw query string logged by default — token / PII exposure — `logger.go:306-308`

**Observed:**
```go
if raw != "" && !conf.SkipQueryString {
    path = path + "?" + raw   // opt-in to *hiding*, not opt-in to *logging*
}
```
`SkipQueryString` defaults to `false`. Query strings frequently carry `?access_token=`, `?api_key=`, or account identifiers. `GLD-STD-009@1` §"Data to exclude" requires credentials and tokens are never logged directly.

**Fix:** Either default `SkipQueryString` to `true`, or add a `SanitizeQuery func(string) string` hook that strips known sensitive parameter names before appending.

---

### [MEDIUM] Mutable exported package-level writers — potential data race — `mode.go:42,45`, `logger.go:36`, `debug.go:27,30`

**Observed:**
```go
var DefaultWriter io.Writer = os.Stdout   // reassignable at any time
var DefaultErrorWriter io.Writer = os.Stderr
var consoleColorMode = autoColor
var DebugPrintRouteFunc func(…)
var DebugPrintFunc func(…)
```
`GLD-STD-003@1` §"Avoid Mutable Globals": mutation after middleware construction (which captures the writer at `LoggerWithConfig` time) or after the first request is a data race. `consoleColorMode` is also read on every request in `IsOutputColor()` with no synchronisation.

**Fix:** Accept writer/hook overrides via `OptionFunc` on `Engine`. Protect `consoleColorMode` with `atomic.Int32`. Document (or enforce) that globals must be set before the first `New()` call.

---

### [MEDIUM] `init()` does I/O and mutates globals — `mode.go:52-55`

**Observed:**
```go
func init() {
    mode := os.Getenv(EnvGinMode)   // I/O
    SetMode(mode)                   // global mutation
}
```
`GLD-STD-003@1` §"Avoid `init()`": avoid I/O, avoid global state mutation, avoid depending on `init` ordering. This makes package startup non-deterministic in test suites that set `GIN_MODE` after import.

**Fix:** Remove the `init`. Document that callers should call `gin.SetMode(os.Getenv(gin.EnvGinMode))` in `main`. `New()` can default to `debugCode` if `ginMode` is zero.

---

### [LOW] Variadic `RecoveryWithWriter` silently drops handlers beyond the first — `recovery.go:45-50`

**Observed:**
```go
func RecoveryWithWriter(out io.Writer, recovery ...RecoveryFunc) HandlerFunc {
    if len(recovery) > 0 {
        return CustomRecoveryWithWriter(out, recovery[0])  // [1], [2] … silently ignored
    }
    …
}
```
Per `GLD-STD-003@1` §"Avoid Naked Parameters": the variadic overload suggests "pass as many as you like" but silently discards all but the first. **Fix:** Remove the variadic; use the two existing distinct functions (`RecoveryWithWriter` / `CustomRecoveryWithWriter`) — a semver-major change.

---

### [LOW] `errors` variable shadows the `errors` package import name — `logger.go:215`

**Observed:**
```go
errors := c.Errors.ByType(typ)   // GLD-STD-003@1 §"Avoid Using Built-In Names"
```
**Fix:** Rename to `errs` or `errList`.

---

### [LOW] `HandleContext` has no reentry guard against infinite loops — `gin.go:680-688`

**Observed:** The comment says "You can loop yourself to deal with this, use wisely" — there is no bounded-depth check. A handler that rewrites its path and calls `HandleContext` unconditionally will exhaust the stack.

**Fix:** Add a `reentryDepth` counter on `Context`, abort with 500 after a configurable maximum (e.g. 10).

---

### [LOW] `defaultLogFormatter` uses `fmt.Sprintf` on every request — `logger.go:185`

Per `GLD-STD-003@1` §"Prefer strconv over fmt": integer fields (`StatusCode`, `BodySize`) should use `strconv.Itoa` and a `strings.Builder` to reduce per-request allocations.

---

## Positive notes

1. **`subtle.ConstantTimeCompare` for credential matching** (`auth.go:37`) — timing-safe comparison, correctly applied. ✓
2. **`sync.Once` for route-tree init in `ServeHTTP`** (`gin.go:663-665`) — concurrency-correct. ✓
3. **Compile-time interface compliance assertions** (`gin.go:191`, `routergroup.go:62`) — exactly what `GLD-STD-003@1` §"Verify Interface Compliance" prescribes. ✓
4. **`sanitizePathChars` on `X-Forwarded-Prefix`** (`gin.go:785`) — good path-injection defence in redirect handling. ✓
5. **`secureRequestDump` exists** — the intent to redact credentials before logging a panic is correct; scope just needs broadening.
6. **`LoggerConfig.SkipQueryString` field exists** (`logger.go:53-55`) — the escape hatch is there; the default just needs to flip.

---

## Summary & recommendation

**Verdict: REQUEST CHANGES**

| Priority | # | File:line | Issue |
|---|---|---|---|
| Must-fix | 1 | `gin.go:225` | Trust-all-proxies default |
| Must-fix | 2 | `mode.go:75`, `routergroup.go:105`, `utils.go:87` | Env-var-triggered panics |
| Must-fix | 3 | `mode.go:48`, `debug.go:23` | Raw `int32` atomic |
| Should-fix | 4 | `recovery.go:98` | Credential header logging (GLD-STD-009@1, GLD-STD-010@1) |
| Should-fix | 5 | `recovery.go:99` | Discarded DumpRequest error |
| Should-fix | 6 | `recovery.go:135` | Stale-file bug in `stack()` |
| Should-fix | 7 | `logger.go:306` | Raw query string logged by default (GLD-STD-009@1) |
| Should-fix | 8 | `mode.go:42,45`, `logger.go:36` | Mutable globals / data races |
| Should-fix | 9 | `mode.go:52` | `init()` with I/O (GLD-STD-003@1) |
| Cleanup | 10–13 | Various | Variadic footgun, `errors` shadowing, reentry guard, strconv |

The review has been saved to **`artifacts/review-routing-middleware.md`**.
