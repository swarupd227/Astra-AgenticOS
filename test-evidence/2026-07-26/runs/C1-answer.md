I'll start by loading the mandatory organisational standard, scanning for security/quality issues, and locating the relevant controllers — all in parallel.Good. This is a Java/Spring stack. Semgrep isn't available, so I'll ground everything by reading both files in full, plus scan for relevant patterns across the codebase — all in parallel.Now let me check for any global exception handler, correlation ID infrastructure, and the `getPet(id)` method to verify the null-return risk:Now I have everything I need. Let me produce the full review and save the artifact.---

# Code Review — `OwnerController.java` & `PetController.java`
**Standard applied:** `GLD-STD-001@1` — Secure Coding Standard
**Stack:** Java / Spring MVC (confirmed from file extensions and package structure)
**Verification:** All findings grounded by `read_file` and `search_code` with cited `file:line`. Semgrep was unavailable (not installed on this server); noted where that limits automated grounding.

---

## Findings (sorted by severity)

---

### 🔴 [HIGH] No logging anywhere in either controller — `GLD-STD-001@1 §1.3`
**Files:** Both controllers (all lines)

**Observed:** A codebase-wide search for `import org.slf4j` returns **zero matches**. Neither controller declares a logger. Every significant event — owner not found, data-integrity violation, pet duplicate rejected — is silently discarded with no operational trace.

**GLD-STD-001@1 §1.3** mandates WARN or above for anything a human must act on. Three concrete violations right now:
- `DataIntegrityViolationException` caught at `PetController.java:128` and `PetController.java:170` — the duplicate-name branch is silently swallowed; the re-throw branch has no log either.
- `IllegalArgumentException` thrown at four `@ModelAttribute` sites goes unrecorded.
- No INFO flow events, making request reconstruction impossible.

**Fix:**
```java
// Both controllers — class level
private static final Logger log = LoggerFactory.getLogger(OwnerController.class);

// PetController.java:128 — caught exception branch
catch (DataIntegrityViolationException ex) {
    if (!isDuplicatePetNameViolation(ex)) {
        log.error("Unexpected integrity violation saving pet for ownerId={}", owner.getId(), ex);
        throw ex;
    }
    log.warn("Duplicate pet name '{}' rejected for ownerId={}", pet.getName(), owner.getId());
    result.rejectValue("name", "duplicate", "already exists");
    return VIEWS_PETS_CREATE_OR_UPDATE_FORM;
}

// Before each orElseThrow
log.warn("Owner not found ownerId={}", ownerId);
```

---

### 🔴 [HIGH] No correlation / request ID on any log — `GLD-STD-001@1 §1.2`
**Files:** Both controllers; entire production codebase

**Observed:** `search_code` for `MDC`, `correlationId`, `X-Request-ID`, `traceId` all return **zero matches**. There is no filter, interceptor, or logging config that stamps a per-request identifier.

**GLD-STD-001@1 §1.2** requires a correlation ID on every request. Without it, any logs added per finding #1 will still be useless for incident investigation.

**Fix:** Add a `OncePerRequestFilter`:
```java
@Component
public class CorrelationIdFilter extends OncePerRequestFilter {
    private static final String HEADER  = "X-Request-ID";
    private static final String MDC_KEY = "correlationId";

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        String id = StringUtils.hasText(req.getHeader(HEADER))
                    ? req.getHeader(HEADER) : UUID.randomUUID().toString();
        MDC.put(MDC_KEY, id);
        res.setHeader(HEADER, id);
        try { chain.doFilter(req, res); }
        finally { MDC.clear(); }
    }
}
```
Then reference `%X{correlationId}` in `logback-spring.xml`.

---

### 🔴 [HIGH] `IllegalArgumentException` leaks internal detail; no global exception handler — `GLD-STD-001@1 §4.2`
**Files:** `OwnerController.java:68-69`, `OwnerController.java:170-171`, `PetController.java:70-71`, `PetController.java:84-85`

**Observed:** Messages such as `"Owner not found with id: " + ownerId + ". Please ensure the ID is correct and the owner exists in the database."` are thrown raw. `search_code` for `@ControllerAdvice` and `@ExceptionHandler` returns **zero matches** — there is no global handler.

Without a handler, Spring MVC's default propagates the uncaught exception to the container, which may render the message in an HTTP error page. The correct HTTP status is 404, not 500. This violates **GLD-STD-001@1 §4.2** ("must not leak internal paths, SQL or stack traces").

**Fix (two-part):**
1. Add a `@ControllerAdvice` that maps `IllegalArgumentException → 404` and logs at `WARN` before responding with a safe view.
2. Strip the advisory text from exception messages — internal guidance belongs in logs, not in exception messages that can escape:
```java
// Before — leaks advisory text
throw new IllegalArgumentException("Owner not found with id: " + ownerId
    + ". Please ensure the ID is correct and the owner exists in the database.");

// After — safe
throw new IllegalArgumentException("Owner not found: id=" + ownerId);
```

---

### 🟡 [MEDIUM] `findPet` returns `null` — unhandled NPE — `GLD-STD-001@1 §4.1`
**File:** `PetController.java:86`

**Observed:** `Owner.getPet(Integer id)` (`Owner.java:117-127`) is documented to return `null` when no match is found. `findPet` passes this `null` back as the `@ModelAttribute("pet")`, causing any downstream handler to throw a `NullPointerException` with zero context.

**Fix:**
```java
Pet pet = owner.getPet(petId);
if (pet == null) {
    throw new IllegalArgumentException("Pet not found: id=" + petId + " for ownerId=" + ownerId);
}
return pet;
```
The `@ControllerAdvice` above then renders a clean 404.

---

### 🟡 [MEDIUM] Redundant owner DB lookup inside `findPet`
**File:** `PetController.java:83-85`

**Observed:** `findPet` re-fetches the owner from the repository (line 83-85) even though `findOwner` already loaded the same entity for the same request. Two repository reads fire for every pet-edit or pet-new request.

**Fix:** Receive the already-resolved `@ModelAttribute("owner")` directly:
```java
@ModelAttribute("pet")
public Pet findPet(@ModelAttribute("owner") Owner owner,
                   @PathVariable(name = "petId", required = false) Integer petId) {
    if (petId == null) return new Pet();
    Pet pet = owner.getPet(petId);
    if (pet == null)
        throw new IllegalArgumentException("Pet not found: id=" + petId + " for ownerId=" + owner.getId());
    return pet;
}
```

---

### 🟡 [MEDIUM] Fragile constraint-name substring match, exception not logged — `GLD-STD-001@1 §1.3 & §4.1`
**File:** `PetController.java:202-205`

**Observed:**
```java
return message != null && message.toLowerCase().contains("unique_owner_pet_name");
```
This relies on the exact constraint name appearing verbatim in the DB vendor's exception message. A schema rename, a different DB vendor, or a different `UNIQUE` constraint on the same table that happens to share the substring will silently mis-classify the exception — either swallowing a real violation or surfacing an unhandled 500, with no log entry in either case.

**Fix:** Log the raw exception every time it is caught (per finding #1). Longer term, use Spring's `ConstraintNameExtractor` abstraction or map constraint names in a vendor-neutral configuration.

---

### 🔵 [LOW] Trailing space in repeated error message string
**Files:** `PetController.java:71`, `PetController.java:85`, `OwnerController.java:171`

**Observed:** `"Please ensure the ID is correct "` (trailing space) is copy-pasted across three sites. Extract to a shared constant and trim the whitespace.

---

## Positive notes

- **`@InitBinder` correctly disallows `id` / `*.id`** on both controllers — prevents mass-assignment of surrogate keys.
- **`@Valid` is applied at the boundary** on all mutating handler parameters — consistent with `GLD-STD-001@1 §3.1`.
- **Birth-date validation** rejects future dates at the controller layer, the right place per §3.1.
- **`DataIntegrityViolationException` is re-raised** (not silently swallowed) in the non-duplicate branch — the intent of §4.1 is partially honoured, even though it still needs a log entry.
- **Owner ID mismatch check** (`OwnerController.java:149`) guards against URL/body ID tampering.

---

## Summary & recommendation

**Decision: ❌ REQUEST CHANGES**

| # | Severity | Finding | Standard clause |
|---|----------|---------|----------------|
| 1 | HIGH | Zero logging in both controllers | GLD-STD-001@1 §1.3 |
| 2 | HIGH | No correlation ID infrastructure | GLD-STD-001@1 §1.2 |
| 3 | HIGH | `IllegalArgumentException` leaks detail; no global handler | GLD-STD-001@1 §4.2 |
| 4 | MEDIUM | `findPet` returns `null` → unhandled NPE | GLD-STD-001@1 §4.1 |
| 5 | MEDIUM | Redundant DB lookup in `findPet` | — |
| 6 | MEDIUM | Fragile constraint-name substring match, unlogged | GLD-STD-001@1 §1.3, §4.1 |
| 7 | LOW | Trailing space in error message | — |

Findings 1–3 are **mandatory `GLD-STD-001@1` violations** and block approval on their own. Findings 4–6 are correctness/reliability defects that should be fixed in the same pass. Finding 7 can follow in a clean-up commit.

---

The full review has been saved to **`artifacts/review-owner-pet-controllers.md`**. Let me know if you'd like fixes drafted as code patches or a follow-up triage ticket using the `GLD-SKL-001` procedure.
