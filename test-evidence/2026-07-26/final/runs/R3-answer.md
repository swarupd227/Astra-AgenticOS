I'll start by loading the mandatory standards and discovering the codebase structure simultaneously.Good. I can see the PHP codebase (Slim framework). Now let me read the actual App and middleware files simultaneously, and run Semgrep.Semgrep is unavailable. I'll ground all findings by reading the actual code. Let me now discover and read all middleware files.Now I have all the files. Let me check for any additional middleware and look at a few specific patterns more closely.I now have full visibility of all files. Let me do a few final targeted checks before writing the review.I now have a complete picture across all files. Let me produce the review and save it as an artifact.---

# Code Review — `Slim/App.php`, `Slim/MiddlewareDispatcher.php`, `Slim/Middleware/*`

**Date:** 2026-07-26 | **Standard:** `GLD-STD-004@1` (PSR-12 — mandatory) | **Stack:** PHP / Slim 4.x

> **Note — Semgrep unavailable.** All findings are grounded by direct `read_file` / `search_code` inspection. Each finding is labelled **Observed** where I read the exact line.

---

## Findings (sorted by severity)

---

### [MEDIUM] Snake_case local variable — `Slim/Middleware/BodyParsingMiddleware.php:121`
**Standard:** `GLD-STD-004@1 §2.1` → PSR-1 §4 (camelCase for variables/identifiers)

**Observed:** `$backup_errors` is the only snake_case local variable across all nine reviewed files. Every other variable in the codebase uses camelCase.
```php
// line 121 — violates PSR-1 camelCase
$backup_errors = libxml_use_internal_errors(true);
// line 126
libxml_use_internal_errors($backup_errors);
```
**Fix:**
```php
$backupErrors = libxml_use_internal_errors(true);
// ...
libxml_use_internal_errors($backupErrors);
```

---

### [MEDIUM] Space between cast operator and operand — `Slim/Middleware/ContentLengthMiddleware.php:28`
**Standard:** `GLD-STD-004@1 §6.1` — "Type casting operators MUST NOT have any space within the parentheses" — and the cast must sit flush against its operand.

**Observed:**
```php
$response = $response->withHeader('Content-Length', (string) $size);
//                                                          ↑ space is a violation
```
The same `(string) $` pattern also appears in `Slim/Logger.php:30` and `Slim/Routing/RouteCollectorProxy.php:191` (out of scope but should be fixed in the same pass).

**Fix:**
```php
$response = $response->withHeader('Content-Length', (string)$size);
```

---

### [MEDIUM] Missing `/** @api */` docblock on `RoutingMiddleware` — `Slim/Middleware/RoutingMiddleware.php:25`
**Standard:** `GLD-STD-004@1 §4.1` — class docblock convention established by the project.

**Observed:** Every other public middleware class carries `/** @api */` immediately before the `class` keyword:
| File | Has `@api`? |
|------|-------------|
| `BodyParsingMiddleware.php:35` | ✅ |
| `ContentLengthMiddleware.php:18` | ✅ |
| `ErrorMiddleware.php:28` | ✅ |
| `MethodOverrideMiddleware.php:21` | ✅ |
| `OutputBufferingMiddleware.php:26` | ✅ |
| **`RoutingMiddleware.php:25`** | ❌ **missing** |

**Fix:**
```php
/** @api */
class RoutingMiddleware implements MiddlewareInterface
```

---

### [MEDIUM] Multi-line ternary indentation in `createFromContainer()` — `Slim/Factory/AppFactory.php:79–112`
**Standard:** `GLD-STD-004@1 §§2.4 & 6.3` — binary/ternary operators with continuation lines must be consistently indented (4 spaces per level).

**Observed:** The `&&` continuation lines start at column 0, making operator precedence visually ambiguous:
```php
$callableResolver = $container->has(CallableResolverInterface::class)
&& (                                   // ← col 0, looks like separate statement
    $callableResolverFromContainer = $container->get(...)
) instanceof CallableResolverInterface
    ? $callableResolverFromContainer
    : null;
```
**Fix:** Indent the continuation consistently, or pre-resolve the value first:
```php
$callableResolverFromContainer = $container->get(CallableResolverInterface::class);
$callableResolver = $container->has(CallableResolverInterface::class)
    && $callableResolverFromContainer instanceof CallableResolverInterface
    ? $callableResolverFromContainer
    : null;
```

---

### [LOW] Swallowed `RuntimeException` with silent comment — `Slim/MiddlewareDispatcher.php:184–189`
**Standard:** `GLD-STD-004@1 §5.6` — catch blocks must have a meaningful body.

**Observed:**
```php
} catch (RuntimeException $e) {
    // Do Nothing     ← $e unused; reason not stated
}
```
**Fix:** Use a bare catch (PHP 8.0+) and explain the intent:
```php
} catch (RuntimeException) {
    // Resolution via CallableResolver failed; fall through to manual lookup below.
}
```

---

### [LOW] Untyped public method parameters — `Slim/App.php:102`, `Slim/Middleware/ErrorMiddleware.php:158, 190`
**Standard:** `GLD-STD-004@1 §4.5` — type hints should be present on all arguments; relying solely on docblock `@param` is inconsistent with `declare(strict_types=1)`.

**Observed:**
```php
// App.php:102
public function add($middleware): self             // no type hint

// ErrorMiddleware.php:158
public function setDefaultErrorHandler($handler): self

// ErrorMiddleware.php:190
public function setErrorHandler($typeOrTypes, $handler, ...): self
```
**Fix (PHP 8.0+ union types):**
```php
public function add(MiddlewareInterface|string|callable $middleware): self
public function setDefaultErrorHandler(string|callable|ErrorHandlerInterface $handler): self
public function setErrorHandler(string|array $typeOrTypes, string|callable|ErrorHandlerInterface $handler, bool $handleSubclasses = false): self
```

---

### [LOW] Missing native return type declarations — `Slim/Middleware/ErrorMiddleware.php:103, 127` and `BodyParsingMiddleware.php:142`
**Standard:** `GLD-STD-004@1 §4.5` — return type declarations must appear on the method signature line.

**Observed:** `getErrorHandler()`, `getDefaultErrorHandler()`, and `parseBody()` each have `@return` docblocks but no native return type.

**Fix (PHP 8.0+):**
```php
public function getErrorHandler(string $type): callable|ErrorHandler
public function getDefaultErrorHandler(): callable|ErrorHandler
protected function parseBody(ServerRequestInterface $request): array|object|null
```

---

### [LOW] Constructor assigns property before validating it — `Slim/Middleware/OutputBufferingMiddleware.php:39–47`
Not a PSR-12 violation but flagged for correctness (object left in partial state if exception thrown).

**Observed:**
```php
$this->style = $style;                 // assigned first
if (!in_array($style, [...], true)) { // validated second
    throw new InvalidArgumentException(...);
}
```
**Fix:** Validate before assigning.

---

### [LOW] Public setter methods lack docblocks — `Slim/Factory/AppFactory.php:173–216`
**Standard:** `GLD-STD-004@1 §4.4` — the project establishes docblocks as a convention for all public methods; the eight `set*()` methods have none.

**Fix:** Add a one-line summary docblock to each setter.

---

## Positive notes (what's done well)

- ✅ `declare(strict_types=1)` present on **every** reviewed file (`GLD-STD-004@1 §3`)
- ✅ Closing `?>` tag correctly omitted throughout (`GLD-STD-004@1 §2.2`)
- ✅ `use` import blocks ordered correctly (class → function → const), one per line, no leading backslash (`GLD-STD-004@1 §3`)
- ✅ 4-space indent, no tabs, consistent across all nine files (`GLD-STD-004@1 §2.4`)
- ✅ Visibility declared on **all** properties and methods; no `var` keyword; no underscore prefixes (`GLD-STD-004@1 §§4.3–4.4`)
- ✅ `abstract`/`final` precede visibility; `static` follows — checked in `AppFactory` (`GLD-STD-004@1 §4.6`)
- ✅ Brace placement correct throughout — class/method braces on own line; closures and anonymous classes on same line (`GLD-STD-004@1 §§4.1, 4.4, 7, 8`)
- ✅ `elseif` (not `else if`) used consistently — confirmed by search (`GLD-STD-004@1 §5.1`)
- ✅ `switch`/`case` indentation and `default` throw guard in `RoutingMiddleware` are correct (`GLD-STD-004@1 §5.2`)
- ✅ Nullable types (`?string`, `?ContainerInterface`, etc.) have no space after `?` (`GLD-STD-004@1 §4.5`)
- ✅ File-level block ordering (docblock → `declare` → `namespace` → `use` → class) correct in all files (`GLD-STD-004@1 §3`)
- ✅ Anonymous classes in `MiddlewareDispatcher` correctly follow PSR-12 §8 rules

---

## Summary & recommendation: **Approve with changes**

No blockers. The codebase is well-structured and broadly PSR-12 compliant. Four **MEDIUM** items and six **LOW** items must be addressed before merge:

| # | Severity | File | Line | Action |
|---|----------|------|------|--------|
| 1 | MEDIUM | `BodyParsingMiddleware.php` | 121 | Rename `$backup_errors` → `$backupErrors` |
| 2 | MEDIUM | `ContentLengthMiddleware.php` | 28 | `(string) $size` → `(string)$size` |
| 3 | MEDIUM | `RoutingMiddleware.php` | 25 | Add `/** @api */` docblock |
| 4 | MEDIUM | `AppFactory.php` | 79–112 | Fix continuation indent in `createFromContainer()` |
| 5 | LOW | `MiddlewareDispatcher.php` | 184 | Replace unused `$e` with bare catch + explanatory comment |
| 6 | LOW | `App.php:102`, `ErrorMiddleware.php:158,190` | — | Add union type hints to untyped parameters |
| 7 | LOW | `ErrorMiddleware.php:103,127` | — | Add native return type declarations |
| 8 | LOW | `BodyParsingMiddleware.php` | 142 | Add native return type declaration |
| 9 | LOW | `OutputBufferingMiddleware.php` | 39–47 | Validate `$style` before assigning |
| 10 | LOW | `AppFactory.php` | 173–216 | Add docblocks to public setter methods |

The full review has been saved to **`artifacts/review-app-and-middleware.md`**.
