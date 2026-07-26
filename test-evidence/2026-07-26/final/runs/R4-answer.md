Now let me run Semgrep on the file and also read the remainder of the Golden Standard (it was truncated):I now have everything I need. Semgrep is not available in this environment, so I'll note that and ground all findings directly in code evidence. Let me do a couple of targeted searches to confirm patterns I spotted:I have everything I need. Let me now compose the review.---

# Code Review — `lib/sinatra/base.rb`
**Standard applied:** `GLD-STD-006@1` — Ruby Style Guide
**Semgrep:** Not installed in this environment — all findings are **Observed** directly in code via `read_file`/`search_code`. Absence of a Semgrep result is not proof of safety.

---

## Findings (sorted by severity)

### [HIGH] `rescue Exception` in non-framework code — `base.rb:482`, `base.rb:702`

**Rule:** GLD-STD-006@1 — "Never rescue `Exception`; rescue `StandardError` instead."

**Observed:**
```ruby
# base.rb:480-484 — Stream#each
rescue Exception => e
  @scheduler.schedule { raise e }

# base.rb:700-703 — Helpers#time_for
rescue ArgumentError => e
  raise e          # vacuous — see LOW below
rescue Exception
  raise ArgumentError, "unable to convert #{value.inspect} to a Time object"
```

**Risk:** `Exception` covers `SignalException`, `Interrupt`, `NoMemoryError`, and `SystemExit`. In `Stream#each`, catching these inside a streaming block can mask a SIGINT and leave connections open. In `time_for`, `StandardError` already covers every realistic conversion error.

**Fix:**
- Line 482: `rescue StandardError => e`
- Line 702: `rescue StandardError` (and remove the vacuous lines 700-701)
- Lines 1197/1202 (`dispatch!`) are intentional framework-level signal intercepts — leave them, but add an explanatory comment.

---

### [MEDIUM] Multi-line ternary operator — `base.rb:1808-1810`

**Rule:** GLD-STD-006@1 — "Avoid multi-line `?:`; use `if`/`unless` instead."

**Observed:**
```ruby
wrapper = block.arity.zero? ?
  proc { |a, _p| unbound_method.bind(a).call } :
  proc { |a, p| unbound_method.bind(a).call(*p) }
```
**Fix:**
```ruby
wrapper =
  if block.arity.zero?
    proc { |a, _p| unbound_method.bind(a).call }
  else
    proc { |a, p| unbound_method.bind(a).call(*p) }
  end
```

---

### [MEDIUM] One-liner `;` method bodies — `base.rb:278`, `base.rb:282`, `base.rb:1573-1575`

**Rule:** GLD-STD-006@1 — "Don't use `;` to terminate statements; one expression per line."

**Observed:**
```ruby
def http_status; 400 end   # BadRequest
def http_status; 404 end   # NotFound
def development?; environment == :development end
# etc.
```
**Fix:** Expand each to a standard three-line `def…end`.

---

### [MEDIUM] Route verb one-liners with column-alignment padding — `base.rb:1539-1553`

**Rule:** GLD-STD-006@1 — same as above; also the guide discourages alignment padding that makes diffs noisy.

**Observed:**
```ruby
def put(path, opts = {}, &block)     route 'PUT',     path, opts, &block end
def post(path, opts = {}, &block)    route 'POST',    path, opts, &block end
# … six more
```
**Fix:** Standard three-line form for each.

---

### [MEDIUM] `class_eval` with a string — `base.rb:1733`

**Rule:** GLD-STD-006@1 — prefer `define_method` over string-`eval` forms.

**Observed:**
```ruby
String === content ?
  class_eval("def #{name}() #{content}; end") :
  define_method(name, &content)
```
This also repeats the multi-line ternary violation. The string branch is internal only (not user-input), but `class_eval` on a string defeats static analysis and syntax checking.
**Fix:** Replace with a `define_method` lambda closure that evaluates the content lazily.

---

### [MEDIUM] `def block.each` singleton one-liner — `base.rb:297`

**Rule:** GLD-STD-006@1 — semicolon body; obscure singleton method on a local proc.

**Observed:**
```ruby
def block.each; yield(call) end
```
**Fix:** At minimum expand to multi-line. Ideally extract a small named wrapper class so the Rack `each` protocol is explicit.

---

### [MEDIUM] Trailing whitespace — `base.rb:2016`

**Rule:** GLD-STD-006@1 — "Avoid trailing whitespace."
**Observed:** A blank line between `set :static_cache_control, false` and `set :static_headers, {}` contains trailing spaces.
**Fix:** Strip it; configure editor to remove trailing whitespace on save.

---

### [LOW] Vacuous `rescue ArgumentError => e; raise e` — `base.rb:700-701`

**Rule:** GLD-STD-006@1 — exceptions should not be caught and immediately re-raised with no modification.
**Fix:** Delete lines 700-701 entirely — the error propagates naturally.

---

### [LOW] `@@mutex` class variable — `base.rb:1895`

**Rule:** GLD-STD-006@1 — "Avoid `@@` class variables due to their nasty behavior in inheritance."

**Observed:**
```ruby
@@mutex = Mutex.new
```
All `Base` subclasses share this exact mutex, which may be intentional but the class-variable form is fragile.
**Fix:** Use a class-instance variable with a class-level `attr_reader`.

---

### [LOW] Lines exceeding 120 characters — `base.rb:1110`, `base.rb:1286`, `base.rb:1698`

**Rule:** GLD-STD-006@1 — hard limit is 120 chars; 80 is preferred. Lines 1110 (~155 chars) and 1698 (~145 chars) exceed the hard limit.
**Fix:** Introduce intermediate variables or break with leading-dot chains.

---

### [LOW] Inconsistent multi-line chain dot position — `base.rb:38-42` vs `base.rb:1431`

**Rule:** GLD-STD-006@1 — "Adopt a **consistent** multi-line method chaining style."
Lines 38-42 use leading-dot (dots at start of continuation lines); other chains elsewhere use trailing-dot. Both are allowed individually, but mixing them in the same file violates the consistency requirement.
**Fix:** Pick one style and apply it file-wide.

---

## Positive notes

- ✅ `# frozen_string_literal: true` at top — prevents mutation bugs, aids GC.
- ✅ `SCREAMING_SNAKE_CASE` constants throughout (`ETAG_KINDS`, `CALLERS_TO_IGNORE`, etc.) — correct.
- ✅ All predicate methods end in `?` consistently — correct per GLD-STD-006@1.
- ✅ `snake_case` naming is used uniformly across methods and variables.
- ✅ `ensure` blocks correctly restore shared state (`@params`, `@default_layout`).
- ✅ `Rack::Utils.escape_html` is applied when interpolating user-supplied strings into HTML error pages.
- ✅ Inline comments cite RFCs and explain non-obvious design choices.

---

## Summary & recommendation

**→ Request changes**

The most important fix is the **`rescue Exception` in `Stream#each`** (HIGH) — it can suppress OS signals in user streaming blocks. The vacuous re-raise in `time_for` is dead code that should be removed at the same time.

The MEDIUM findings (multi-line ternary, `;` one-liners, `class_eval` string, route-verb one-liners) are clear style violations against `GLD-STD-006@1` and should be corrected before merge.

> **Vendored-code caveat:** If `lib/sinatra/base.rb` is upstream Sinatra source pinned as a dependency, patching it is inadvisable — instead pin the violations in `.rubocop_todo.yml` and track them as accepted exceptions. The HIGH finding about `rescue Exception` in `Stream#each` should still be raised as a bug report upstream.

The review has been saved as `review-lib-sinatra-base.md`. Would you like me to generate a `.rubocop.yml` configuration that captures the agreed-upon style rules, or produce a patch diff for any of the findings?
