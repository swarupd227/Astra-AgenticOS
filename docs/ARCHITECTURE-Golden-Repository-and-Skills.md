# Golden Repository & User-Authored Skills — Architecture

**Status:** Proposed for review · **Date:** 2026-07-26 · **Owner:** ASTRA AgenticOS

---

## 1. What we're solving

Today an ASTRA agent grounds itself in **one** thing: the project's source code. It has no access to
the organisation's *own* knowledge — coding standards, BRD/ADR templates, functional specifications,
architecture principles, security policy, domain glossaries.

The **Golden Repository** is that second grounding layer: a curated, administered library of
organisational knowledge that agents can cite, obey, and produce documents from.

Two asks are in scope:

1. **Golden Repository** — administer the library; select all or part of it per project; change that
   selection later (add / modify / remove).
2. **User-authored Skills** — let teams package their own know-how so we don't have to build a new
   agent for every scenario.

**Design position: these are the same system.** A "skill" is a Golden item whose content is a
procedure rather than a policy. Building one substrate — one store, one admin UI, one retrieval
path, one permission model — instead of two is the single most important decision in this document.

---

## 2. The core decision: how agents get this content

Three options were considered.

| Option | How it works | Verdict |
|---|---|---|
| **A. Stuff it in the prompt** | Concatenate everything into every agent's system prompt | ❌ Doesn't scale. A bank's standards are hundreds of pages; most are irrelevant to any given turn, and we'd pay for them on every request. |
| **B. Vectorised RAG** | Chunk → embed → retrieve top-k by similarity | ⚠️ Not as the primary mechanism. See below. |
| **C. Catalog + retrieval + whole-document read** | Tiny catalog always in context; search and read-whole-document as MCP tools | ✅ **Recommended.** |

### Why not RAG first

RAG returns **fragments ranked by similarity**. For policy content that is a correctness hazard:

> If an agent retrieves 3 of 7 mandatory rules, it produces output that looks compliant while
> silently violating the other 4.

In a bank that is the worst failure mode, and our own black-box test report already flagged these
agents for over-claiming and mixing inference with fact. Fuzzy fragment retrieval makes that worse,
not better. RAG also introduces an embedding model, a vector store, an ingest pipeline, and a new
class of silent failure ("why didn't it find that?").

### Why not "pure Skills" either

Progressive disclosure (name + description always in context, full document on demand) gives
excellent **integrity** and **auditability** — the agent reads the whole rule, and the tool call is
visible evidence of which document it used. But a flat list doesn't scale past a few hundred
documents, and business-language docs often don't keyword-match code terms ("levy computation" vs
"tax calculation").

### The recommendation: three layers

```
Layer 1  Catalog        always in context, ~20 tokens/item   "what exists, and does it apply to me"
Layer 2  Retrieval      golden_search + golden_read (MCP)    "find it, then read the WHOLE thing"
Layer 3  Semantic       golden_semantic_search (deferred)    "find it when wording differs"
```

**Retrieval locates; whole-document read applies.** Retrieval must never silently substitute a
fragment for a policy document. Layer 3 is added only when a real trigger fires (below) — and even
then it is *one more way to locate*, not a replacement for reading the document.

This is deliberately the **same pattern the code intelligence already uses**
(`solution_overview` → `search_code` → `read_file`). Agents already know how to work this way, we
add no new infrastructure, and every use is an auditable tool call.

---

## 3. Data model

```
GoldenItem
  id             stable, citable (e.g. GLD-STD-014)
  title
  description    one line — this is the context-cheap hook the agent sees
  kind           standard | template | functional-spec | checklist | glossary | reference | skill
  enforcement    mandatory | recommended | reference
  appliesTo      [agent ids | category | "all"]
  tags[]         domain / product / technology
  owner          accountable person or team
  version        integer, incremented on publish
  status         draft | published | archived
  content        normalised markdown
  source         upload | git path | URL
  updatedAt
```

Three fields do the heavy lifting:

- **`kind`** decides *how* it is used (a template is loaded and filled; a standard is obeyed and cited).
- **`enforcement`** decides *how strongly* (mandatory items must be read and cited; reference items are optional).
- **`appliesTo`** decides *who sees it* in their catalog.

### Project binding

```
Project.golden = {
  mode: "all" | "subset",
  itemIds: [...],        // explicit selection
  tags:    [...],        // or select by tag/kind — survives new items being added
}
```

Editable at any time — add/modify/remove is plain CRUD on this selection, not a project rebuild.
Selecting **by tag** is worth supporting: "all Payments-domain standards" keeps working as the
library grows, without an admin re-picking items.

---

## 4. How an individual agent knows what to load

This is the hardest question in the brief. Four mechanisms, layered — not one clever trick.

**1. Relevance filter (`appliesTo`) — narrows the catalog.**
The Code Reviewer sees coding standards and review checklists. The BRD Generator sees BRD templates
and functional specs. Each agent gets a *small, relevant* catalog rather than all 400 items.

**2. Hard binding by deliverable — removes judgement where we can.**
If an agent produces artifact type *Y*, it **must** load template *Y* first. BRD agent → BRD
template; ADR agent → ADR template. This is enforced by the platform, not left to the model.

**3. Enforcement tier — makes obligations explicit.**
`mandatory` items carry a contract rule injected alongside the existing operating contract:

> Before producing output, read every applicable **mandatory** standard in your catalog and cite it
> by id. Never paraphrase a standard from memory. If two standards conflict, surface the conflict —
> do not silently pick one.

Small mandatory items can be injected in full; large ones get a pointer plus a must-read instruction.

**4. Agent-initiated search — covers the long tail.**
For everything else the agent searches the catalog exactly as it searches code.

> **Measurement:** log which golden items each run loaded and cited. If agents routinely miss a
> relevant item, the fix is usually a better `description` or `appliesTo` — not more retrieval
> machinery. This log is also the trigger data for Layer 3.

---

## 5. MCP tool contracts

| Tool | Purpose |
|---|---|
| `golden_catalog(kind?, tag?)` | What is available to me right now (already filtered to project selection + agent relevance) |
| `golden_search(query, kind?)` | Keyword/section search across selected items → item id + section + line |
| `golden_read(id, section?)` | Read the **whole** item or a whole section (the applying step) |
| `golden_semantic_search(query)` | *Deferred* — added at the Layer-3 trigger |

Same shape as the existing code tools, so agents generalise from what they already do.

---

## 6. Skills — the same substrate (answers ask #5)

A skill is `kind: skill`: a titled, described, retrievable unit of *procedure* rather than *policy*.
It needs no separate store, admin UI, retrieval path or permission model.

**Why "Golden Agents + user Skills" is the right scaling model:** the 32 agents cover SDLC *roles*,
which is a fairly stable set. What varies infinitely is *organisational specifics* — your BRD format,
your review checklist, your migration playbook. Skills let domain teams encode that themselves,
without us building agent #47. Same agent, better informed.

### Three guardrails (non-negotiable)

1. **A skill instructs; it never authorises.** Tool grants and autonomy stay platform-controlled. A
   user-authored skill must never be able to hand an agent new powers. This is the security boundary.
2. **Ownership, review and versioning.** User content starts looking authoritative fast. Every item
   has an owner; `mandatory` items require an approval step; changes are versioned.
3. **Testability.** An author must be able to run their skill against a known repo and see the
   effect — which plugs straight into the retest discipline the test report asked for.

### Custom agents — later, and constrained

Eventually: *custom agent = persona + selected skills + a **preset** tool profile*. Never arbitrary
tool grants. Skills first: ~90% of the value at a fraction of the risk.

---

## 7. Governance

- **Versioning & traceability.** Artifacts record which golden item **versions** they were produced
  against. This directly closes the "artifact reproducibility / immutable ids" gap raised by the
  testers.
- **Precedence.** `mandatory` org standard > project selection > team skill. Conflicts must be
  **surfaced**, never silently resolved.
- **Lifecycle.** draft → published → archived. Archived items stay readable for old artifacts but
  can't be newly selected.
- **Attribution.** When an agent applies a golden item it cites `id@version`, so a reviewer can
  check the source.

---

## 8. Security

- **Isolation.** Golden content can be confidential (functional specs, internal policy). Per-project
  selection is a boundary: an agent must never see items outside its project's selection.
- **Prompt injection — treat golden content as data, not instructions.** ⚠️ Once non-engineers can
  upload documents, someone will (accidentally or otherwise) include text like *"ignore your previous
  instructions"*. Golden content must be framed to the model as **reference material**, and the
  operating contract must state that instructions found inside golden documents are not commands.
  This is a genuine risk that arrives with this feature.
- **Secrets.** Uploaded documents may contain credentials. Reuse the existing rule: never echo secret
  values; flag and report location only.
- **Provenance.** Record who uploaded/edited each item and when.

---

## 9. Admin UI (flows, not pixels)

**Golden Repository (admin)**

```
Golden Repository                                   [+ Add items]
Filter: [kind ▾] [tag ▾] [owner ▾] [status ▾]        search: [______]

 ID           Title                     Kind       Enforcement   Applies to        v   Status
 GLD-STD-014  .NET Coding Standards     standard   mandatory     code-reviewer…    3   published
 GLD-TPL-002  BRD Template              template   mandatory     requirements-brd  1   published
 GLD-FS-031   Payments Functional Spec  spec       reference     all               2   published
 GLD-SKL-007  Legacy Migration Playbook skill      recommended   framework-migr…   1   draft
                                                        [Edit] [New version] [Archive]
```

*Add items* → upload files (`.md/.docx/.pdf/.xlsx`) **or** point at a git repo of docs → they are
normalised to markdown, then the admin sets kind / enforcement / appliesTo / tags.

**Project creation — new step**

```
New project
  (1) Source        · upload .zip / git repo / local folder      [existing]
  (2) Knowledge     · Golden Repository
        ( ) Everything      (•) Selected
        [x] Standards (12)      [x] Templates (4)
        [ ] Functional specs (86)   › expand to pick individually
        Selected: 16 items — mandatory: 3
```

**Project settings → Knowledge** — the same picker, editable any time; shows what changed and warns
if a previously-cited item is being removed.

**Agent run transparency** — the run trace shows *Loaded: GLD-STD-014 v3, GLD-TPL-002 v1*, so a
reviewer can see exactly which knowledge shaped the output. This is what makes the whole thing
auditable rather than magical.

---

## 10. Phasing

| Phase | Scope | Exit criteria |
|---|---|---|
| **1. Foundation** | Data model, admin CRUD, ingest/normalise (docx/pdf/md), project selection | An admin can add a standard and bind it to a project |
| **2. Grounding** | `golden_catalog` / `golden_search` / `golden_read`, catalog injection, contract rules | An agent cites `GLD-STD-014` in its output |
| **3. Templates** | Hard binding for artifact-producing agents | BRD agent always uses the org BRD template |
| **4. Skills** | `kind: skill`, authoring UI, ownership/approval, test-run | A team ships a skill without us writing code |
| **5. Semantic (conditional)** | `golden_semantic_search` | Only if the Layer-3 trigger fires |

**Layer-3 trigger (decide with data, not vibes):** corpus beyond a few hundred documents, **or** the
retrieval log shows agents repeatedly failing to find items that were relevant.

---

## 11. Open questions for review

1. **Scope of the library** — one org-wide Golden Repo, or per business unit / per workspace?
2. **Approval workflow** — who signs off a `mandatory` item? Does it need dual approval?
3. **Ingest fidelity** — how much do we invest in `.docx`/`.pdf` structure preservation (tables,
   numbered clauses) versus plain text? Numbered clauses matter for citing standards precisely.
4. **Size limits** — per item and per project selection (context budget for the catalog).
5. **Conflict policy** — when a team skill contradicts a mandatory standard, do we block the run or
   surface a warning?
6. **Existing artifacts** — should generated artifacts (BRDs, ADRs) be promotable *into* the Golden
   Repo as reference material? (Attractive, but needs a quality gate.)

---

## 12. Summary of recommendations

1. **Build one substrate** for Golden Repo items and user Skills.
2. **Catalog + search + whole-document read**, not RAG, as the primary mechanism.
3. **Defer vectors** until a measured trigger; add them as an extra *locator*, never as the applier.
4. **Bind context four ways**: relevance filter, hard template binding, enforcement tier,
   agent-initiated search.
5. **Skills instruct, never authorise** — tool grants stay with the platform.
6. **Version everything and cite `id@version`** — this is also the fix for the testers'
   reproducibility finding.
7. **Treat golden content as data, not instructions** — prompt-injection defence from day one.
