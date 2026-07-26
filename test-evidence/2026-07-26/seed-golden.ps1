# Seeds a representative Golden Repository: one item of each kind that a bank
# would realistically load, deliberately covering every enforcement level and
# both binding styles (appliesTo: all vs. a single agent).
$ErrorActionPreference = "Stop"
$base = "http://localhost:5173"

function New-GoldenItem($o) {
  $body = $o | ConvertTo-Json -Depth 6
  $r = Invoke-RestMethod -Uri "$base/api/golden" -Method Post -ContentType 'application/json' -Body $body
  "{0,-14} {1,-13} {2,-11} {3}" -f $r.item.id, $r.item.kind, $r.item.enforcement, $r.item.title
  return $r.item.id
}

$items = @()

# 1. A MANDATORY standard that applies to everyone — the classic "our coding rules".
$items += New-GoldenItem @{
  title = "Secure Coding Standard"
  description = "Mandatory rules for logging, secrets, input validation and error handling in any language."
  kind = "standard"; enforcement = "mandatory"; appliesTo = @("all")
  tags = @("security","engineering"); aliases = @("logging rules","secrets handling","opsec")
  owner = "Security Guild"; approvedBy = "M. Fischer (CISO)"; status = "published"
  content = @"
# Secure Coding Standard

## 1. Logging
1.1 Never log secrets, passwords, API keys, tokens or full card numbers.
1.2 Log the correlation id on every request so a transaction can be traced end to end.
1.3 Log at WARN or above for anything a human must act on. INFO is for flow, not alarm.

## 2. Secrets
2.1 Secrets come from the platform's secret store, never from source, config files or environment defaults.
2.2 A secret found in source is a P1 incident, not a code-review comment.

## 3. Input validation
3.1 Validate at the boundary — controller, handler or message consumer — not deep in the domain.
3.2 Reject unknown fields rather than silently ignoring them.

## 4. Error handling
4.1 Never swallow an exception without either handling it or re-raising with context.
4.2 An error returned to a caller must not leak internal paths, SQL or stack traces.
"@
}

# 2. A MANDATORY template bound to ONE agent — exercises the Phase 3 template gate.
$items += New-GoldenItem @{
  title = "Architecture Decision Record Template"
  description = "The required structure for every ADR produced at the bank."
  kind = "template"; enforcement = "mandatory"; appliesTo = @("architecture-adr")
  tags = @("architecture"); aliases = @("ADR format","design record")
  owner = "Architecture Guild"; approvedBy = "J. Weber (Chief Architect)"; status = "published"
  content = @"
# ADR-<number>: <short title>

## Status
Proposed | Accepted | Superseded by ADR-<n>

## Context
What forces are at play. Written so someone joining in two years understands why this was even a question.

## Decision
What we are doing, in one paragraph, in the active voice.

## Consequences
### Positive
### Negative
### Risks we are accepting

## Alternatives considered
For each: what it was, and the specific reason it lost.

## Compliance
Which standards this decision must satisfy, cited as id@version.
"@
}

# 3. A RECOMMENDED checklist — should be used when relevant, never blocking.
$items += New-GoldenItem @{
  title = "Pre-Release Review Checklist"
  description = "What a reviewer confirms before any change ships to production."
  kind = "checklist"; enforcement = "recommended"; appliesTo = @("all")
  tags = @("engineering","release"); aliases = @("go-live checks","release gate")
  owner = "Release Management"; status = "published"
  content = @"
# Pre-Release Review Checklist

## A. Correctness
A.1 Every new branch in the logic has a test that fails without the change.
A.2 Error paths are tested, not just the happy path.

## B. Operability
B.1 The change is observable — a new failure mode produces a log or metric someone will see.
B.2 It can be rolled back without a data migration.

## C. Data
C.1 No personal data crosses a new boundary without a documented lawful basis.
C.2 Schema changes are backward compatible for at least one release.
"@
}

# 4. A REFERENCE glossary with aliases — the case ranked search + aliases exist for.
$items += New-GoldenItem @{
  title = "Payments Domain Glossary"
  description = "What the bank's payment terms mean, so code and requirements use the same words."
  kind = "glossary"; enforcement = "reference"; appliesTo = @("all")
  tags = @("payments","domain"); aliases = @("levy","duty","settlement terms","nostro")
  owner = "Payments Domain Team"; status = "published"
  content = @"
# Payments Domain Glossary

## Settlement
The irrevocable transfer of value between two parties. Distinct from *clearing*, which only
establishes the obligation.

## Levy
Any statutory charge applied to a transaction by an authority. In code this is modelled as a
`Charge` with `ChargeType.Statutory` — never as a fee.

## Nostro / Vostro
A nostro is our account held at another bank. A vostro is their account held at us. Reversing
these two is the single most common defect in reconciliation code.

## Value date
The date on which funds become available, which is not necessarily the booking date.
"@
}

# 5. A SKILL — a user-authored procedure, the Phase 4 feature.
$items += New-GoldenItem @{
  title = "How We Triage a Production Defect"
  description = "The bank's own procedure for turning a reported defect into a prioritised, reproducible ticket."
  kind = "skill"; enforcement = "recommended"; appliesTo = @("all")
  tags = @("engineering","support"); aliases = @("incident triage","defect handling")
  owner = "Engineering Ops"; status = "published"
  content = @"
# Skill: Triaging a Production Defect

Follow these steps in order. Do not skip step 2 — a defect that cannot be reproduced
cannot be verified as fixed.

## Step 1 — Establish blast radius
Identify who is affected and how many. State the number, or state that it is unknown.

## Step 2 — Reproduce
Find the smallest input that triggers it. Record the exact steps. If you cannot reproduce it,
say so explicitly rather than guessing at a cause.

## Step 3 — Locate
Find the code path from the evidence, not from intuition. Cite file and line.

## Step 4 — Classify severity
Severity requires a named caller and a stated impact. "Looks risky" is not a severity.

## Step 5 — Write the ticket
Title states the observable symptom, not the suspected cause.
Body contains: blast radius, reproduction steps, located code path, severity with justification.
"@
}

"`n$($items.Count) items seeded."
$items -join ","
