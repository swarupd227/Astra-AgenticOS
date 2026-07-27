# ASTRA AgenticOS — Defect & UX Log

**Date:** 27 July 2026
**Scope:** All 32 agents against a .NET codebase, 12 runs across 6 other languages, Golden
Repository loaded from the Insurity EAIS pack, everything driven through the browser UI
against the Azure deployment.

---

## 1. Summary

| | Count |
|---|---|
| Defects found and fixed | 7 |
| Defects found, not yet fixed | 2 |
| Reported in error, then retracted | 2 |
| UX observations | 8 |
| Agent runs executed | 44 (32 .NET + 12 cross-language) |
| Runs with errors, timeouts or empty output | 0 (after the renderer fix) |

Two fixes are committed but **not deployed**: `36905c6`. Everything else is live.

---

## 2. Defects found and fixed

### D-1 · Short agent answers were silently discarded — **critical**

*Found: cloud smoke testing. Fixed `d8f6c8d`. Deployed and verified.*

A message showed only "Used 1 tool" with no text. The server had streamed a complete
answer — 375 characters over 10 `text_delta` events, confirmed by reading the raw NDJSON.
The UI threw it away.

`scheduleRender()` queues a `requestAnimationFrame` whose callback checks `if (mdEl)`
before painting. A `tool_call` closes the current text block by setting `mdEl = null`. When
the deltas and the tool call land inside the same frame — the normal case for a short answer
— the queued callback ran after `mdEl` was already null, skipped the render, and left an
empty div.

**Why it hid for so long:** long answers were unaffected. Frames fire between deltas, so
their text was already painted. Only short, fast answers lost their text — which is why
every earlier test passed. They were all long reviews.

This had almost certainly been discarding short answers for as long as the UI has existed.
The answers were generated and billed; users just never saw them.

**Fix:** `flushRender()` cancels the queued frame and paints immediately, called before the
text block is closed in both `tool_call` and `finish()`. `text_reset` cancels its pending
frame too.

**Verified:** 20+ consecutive agents at `emptyBlocks: 0`, in the cloud.

### D-2 · Tall modals overflowed the screen, hiding Save/Cancel — **high**

*Reported by swarupd. Fixed `b526a80`. Deployed and verified.*

`.modal` had `overflow: hidden` and no `max-height`. On a shorter screen the Golden item
editor grew past the viewport and the clipped footer took Save and Cancel with it, with no
scrollbar to reach them. The form could be filled in but never saved.

The Word/PDF file picker sits directly above the footer, so it was cut off by the same
clipping — the reported "I could not see the upload option" was the same bug, not a second
one.

**Fix:** `.modal` capped at `calc(100dvh - 40px)` as a flex column; header and footer fixed,
only the body scrolls (`min-height: 0` is what actually allows a flex child to scroll).
Golden editor widened to 640px.

**Verified** at 1280×600, 1024×420 and 375×812, plus no regression in the project dialog,
Settings or the artifact viewer.

### D-3 · Repositories with unfamiliar build systems appeared empty — **high**

*Found: 12-repository indexing sweep. Fixed `7eb5e80`. Deployed.*

Hit 2 of 12 repositories. `solution_overview` — the first tool nearly every agent calls to
orient itself — recognised projects by build manifest. For **jq** (C, autotools) and
**os-lib** (Scala, Mill) it found none and returned exactly one line:

```
No projects found under source root: ...
```

No file count, no folders. An agent would reasonably conclude the repository was empty.

The code was **fully indexed the whole time**. In that same "empty" repository,
`find_symbol` located `jv_parse` at `src/jv_parse.c:913`. Only the orientation tool was blind.

**Fix, twice over:** added the missing manifests (autotools, Mill, Meson, Bazel, plain
Makefile, `.vbproj`/`.fsproj`), and — because there will always be a build system we don't
know — `solution_overview` now falls back to the indexed source layout and states plainly
that the code *is* indexed and the other tools work.

### D-4 · First tool call on a large repository could time out — **medium**

*Found: nopCommerce (3,901 files). Fixed `7eb5e80`. Deployed.*

The MCP client used the SDK's default 60-second per-call timeout. The initial index of a
large repository exceeds it, so an agent's opening move returned
`MCP error -32001: Request timed out`. The existing warm-up hit the same limit and swallowed
it silently, so nothing in the logs explained why.

**Fix:** per-call budget is now `MCP_TIMEOUT_MS` (default 10 minutes) on both the warm-up and
real calls, and a warm-up failure is logged with the remedy.

*Caveat:* the post-fix retest ran on a warm OS file cache, so its 4-second result does not by
itself prove the fix. What is proven is that the cap is no longer 60s and the failure is no
longer silent.

### D-5 · Word/PDF upload always failed — **medium**

*Found: while building the feature. Fixed `aa20e84`. Deployed.*

`POST /api/golden/convert` was registered *after* `POST /api/golden/:id`. Express matches in
registration order, so "convert" was swallowed as an item id and every upload failed with
`No such golden item: convert`.

**Fix:** route moved above `:id`, with a comment recording why it must stay there.

### D-6 · New Project form re-opens when only the refresh failed — **medium**

*Found by reading the code. Fixed `36905c6`. **Not deployed.***

`submitNewProject` wrapped both the creation call **and** `afterProjectChange()` in a single
`try/catch` whose handler calls `reopenModal()`. A failure in the refresh path — `loadProjects`,
the agents fetch, `refreshHealth` — re-opened the form with an error message *after the project
had already been created*. The user is told it failed when it did not, and retrying produces a
duplicate.

**Fix:** creation success is tracked separately. On a refresh failure the form stays closed and
the page reloads, because the app's view of state is stale rather than the project missing.

### D-7 · Dead duplicate of `fmtSize` — **low**

*Fixed `36905c6`. **Not deployed.***

`fmtSize` was declared twice in `app.js` with two different implementations. Function
declarations hoist, so the later one always won and the earlier body never ran. Pre-existing;
removing the dead copy changes nothing at runtime.

---

## 3. Defects found, not yet fixed

### O-1 · Agents can cite a standard without reading it — **medium**

Confirmed from server-side transcripts. Spec Validator and Traceability both cited mandatory
Insurity standards by exact id and version while their threads contain **no** `golden_read`,
`golden_search` or `golden_catalog` call:

- Traceability: `GLD-STD-008@1`, `GLD-STD-009@1`, `GLD-CHK-002@1`, `GLD-STD-007@1`
- Spec Validator: `GLD-CHK-002@1`, `GLD-STD-008@1`, `GLD-STD-009@1`

**Cause:** the catalog injected into every system prompt renders each item with both id and
version — `` `GLD-STD-008` v1 · **standard** · **MANDATORY** · … `` — so a well-formed
`GLD-STD-008@1` requires no reading at all.

**Rate — important context.** This is a leak, not a collapse. Across the six measured
cross-language runs, five had citations exactly equal to `golden_read` count. Every observed
exception correlates with an unusually *short* run: the agent that did the least work is the
one that cited without opening anything.

**Proposed fix:**
1. Drop the version from the catalog line. `golden_read` already emits *"Cite as id@version"*,
   so a correct `@version` could then only come from actually reading the document.
2. Verify server-side at end of run. `runAgent` already tracks `goldenReadThisRun` for the
   template gate — compare cited ids against that set and flag any citation for a document
   never opened. A factual check, not a prompt request.

### O-2 · No bulk import for the Golden Repository — **high (adoption blocker)**

Items are added one file at a time. There is no folder or zip import. The Insurity pack
contains **199 files**; loading it through the current UI is impractical, and this is the
first thing a team must do before the feature is useful at all.

The zip-upload plumbing already exists for projects and could be reused.

---

## 4. Reported in error, then retracted

Recorded because a defect log is only trustworthy if it also records its own mistakes.

### R-1 · "New Project modal does not close after a successful create"
### R-2 · "Adding a project while another is indexing silently does nothing"

**Neither is reachable by a real user.** The busy overlay is `position: fixed; inset: 0` at
`z-index: 120`; `elementFromPoint` over the project button returns `busy-overlay` across the
full viewport. Nobody can open the New Project dialog while a project is being added.

What I actually observed was my own automation calling `.click()` directly, which skips
hit-testing. It landed on a disabled button, did nothing, and left the form untouched — which
I misread as both defects.

The one real bug that came out of investigating them is D-6 above.

---

## 5. UX observations

**U-1 · The template gate's blocking branch has never been observed firing.** Across every run
in this exercise, agents read their bound template *before* saving, so `save_artifact` was never
actually refused. The binding demonstrably works; the platform-level refusal behind it remains
unproven. It is defence for the case where a model does not comply, and no model has yet failed
to comply.

**U-2 · A mandatory item scoped to `appliesTo: all` is read on 100% of runs**, including ones
where it has nothing to say. Observed a Rust dependency audit produce the trailing parenthetical
*"(GLD-STD-001@1 applied for secrets/logging surface review.)"* — close to ritual. Recommend
scoping mandatory items with `appliesTo` or tags unless the rule genuinely applies to every
deliverable.

**U-3 · Same agent, up to 14× difference in thoroughness across repositories.** Code Reviewer,
identical prompt: 3 tool calls / 43s / 1,210 chars on Go, versus 42 tool calls / 336s /
14,326 chars on PHP. May be legitimate, but output depth is not predictable per agent.

**U-4 · Project activation costs a consistent ~20 seconds** (21s, 20s, 20s for Go, Python, PHP)
with only a spinner for feedback.

**U-5 · Conversation history is project-scoped with no cross-project view.** `/api/threads`
returns only the active project's threads, so reviewing another project's conversations means
switching to it and paying the reindex. By design, but it is friction when comparing findings
across repositories.

**U-6 · Two files in the supplied Insurity pack are empty (0 KB)** — `02_Domain_Model/Domain_Glossary.md`
and `02_Domain_Model/Insurance_Domain_Model.md`. Your side, not the platform's, but the domain
glossary is exactly what the requirements agents would reach for.

**U-7 · The .NET test target is small** — AstraOSTesting indexes 31 source files across 7
projects. Sufficient to exercise every agent, but agents whose job needs a large surface (Dead
Code, Tech-Debt Hotspot, Dependency Mapper) legitimately had little to find. Thin output from
those is not evidence of a defect.

**U-8 · Pre-caching run times were 240–420 seconds per agent.** Those figures appear in the
raw data and are a pessimistic baseline, not the steady state — see §6.

---

## 6. Prompt caching — added and verified

No prompt caching existed; `cache_control` appeared nowhere. Every tool call re-sent the entire
prefix — tool schemas, system prompt, full conversation — at full input price, dozens of times
per run.

Added two breakpoint groups: one on the system block (which covers the tool schemas, since
render order is tools → system → messages), and rolling markers on the conversation spaced 15
content blocks apart. The spacing matters: each breakpoint searches back at most 20 blocks, and
a single turn here adds far more than that. Get it wrong and the conversation is re-billed in
full while looking exactly like working code.

**Measured, cloud, cumulative across the session:**

```
read: 3,943,317   written: 539,576   uncached: 244   hitRate: 1.0
```

244 uncached tokens across ~3.9 million. Like-for-like on comparable runs:

| | Before | After |
|---|---|---|
| Architecture/ADR — 57 tools | 360s | — |
| Modernization .NET 10 — 53 tools | — | 148s |
| Fastest agent | 127s | 38s |

Roughly **2.4× faster per tool call**, and about **80% lower input-token cost**. A `cache` block
on `/api/health` makes the hit rate checkable, because a silent invalidator is otherwise
indistinguishable from working code.

---

## 7. Verified working

- **12 languages** extract real symbols from real public repositories — C#, Java, Python, Go,
  PHP, Ruby, Rust, Scala, C, C++, TypeScript, JavaScript.
- **Golden Repository isolation is enforced at the MCP layer**, not merely in the prompt. A Go
  project asking for the PHP standard gets *"not available to this project"*; the PHP project
  reads it.
- **Word/PDF import**, including table and clause-structure preservation, magic-byte type
  checking, and a scan that flags document text written as instructions to an AI.
- **Durability** — the Golden Repository and all projects survived two container replacements.
- **Template binding** — an ADR produced on a Go repository matched the bound template's section
  structure exactly.
- **Alias search** — a query for "levy" found the glossary that never contains the word.

---

## 8. Recommended order of work

1. **Deploy `36905c6`** (D-6, D-7) — small, and D-6 can create duplicate projects.
2. **Golden Repository bulk import** (O-2) — the adoption blocker.
3. **Citation verification** (O-1) — cheap, and it restores the guarantee the feature sells.
4. **Add authentication.** Still outstanding and now the most pressing: the app has no sign-in
   while holding organisational standards and accepting document uploads.
5. **Rotate the API key** — exposed in chat earlier; never committed to git (verified).
