# Tier 2: do the agents actually LEVERAGE the Golden Repository, on real polyglot code?
# Each case names the golden item it should pull in and why. Full NDJSON is kept per run.
# A case passes only if the agent OPENED the item (golden_read) — not merely mentioned it.
$ErrorActionPreference = "Continue"
$base = "http://localhost:5173"
$out  = "C:\Users\swarupd\demo\AgenticOS\test-evidence\2026-07-26\runs"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$cases = @(
  @{ id="C1"; project="petclinic-java";    agent="code-reviewer";
     expect="GLD-STD-001"; why="Mandatory secure-coding standard must ground a Java review";
     task="Review the owner and pet controllers for logging and error-handling problems. Apply our organisation's standards." }

  @{ id="C2"; project="flask-python";      agent="config-secrets-auditor";
     expect="GLD-STD-001"; why="Secrets clause 2.1/2.2 must drive a Python secrets audit";
     task="Audit this Python codebase for hardcoded secrets and unsafe configuration defaults." }

  @{ id="C3"; project="gin-go";            agent="architecture-adr";
     expect="GLD-TPL-003"; why="TEMPLATE GATE: ADR template is bound to this agent; save_artifact must be blocked until read";
     task="Write an ADR recording the decision to use gin's middleware chain for request logging. Save it as adr-logging-middleware.md." }

  @{ id="C4"; project="angular-realworld"; agent="frontend-architecture";
     expect="GLD-CHK-001"; why="Recommended pre-release checklist should inform a front-end review";
     task="Map this Angular app's architecture and tell me what a reviewer should confirm before it ships." }

  @{ id="C5"; project="slim-php";          agent="reliability-auditor";
     expect="GLD-SKL-001"; why="User-authored SKILL: the triage procedure should shape how a defect is worked";
     task="A user reports intermittent 500s from this PHP app in production. Triage it the way our organisation does." }

  @{ id="C6"; project="petclinic-java";    agent="requirements-brd";
     expect="GLD-GLO-001"; why="ALIAS TEST: task says 'levy', glossary registers that word; no doc contains it";
     task="We need to add a statutory levy to each visit charge. What does our organisation mean by that term, and where would it fit in this codebase?" }

  @{ id="C7"; project="miniredis-rust";    agent="dependency-health";
     expect="(none)"; why="NEGATIVE CONTROL: no golden item is relevant; agent must not fake a citation";
     task="Assess the health of this Rust project's dependencies from Cargo.toml." }
)

$projs = (Invoke-RestMethod "$base/api/projects").projects
$rows = @()

foreach ($c in $cases) {
  Write-Host "`n=== $($c.id)  $($c.project) / $($c.agent) ===" -ForegroundColor Cyan
  Write-Host "    expect: $($c.expect) — $($c.why)" -ForegroundColor DarkGray
  $row = [ordered]@{ case=$c.id; project=$c.project; agent=$c.agent; expected=$c.expect
                     goldenRead=""; cited=""; blocked=""; verdict=""; note="" }
  try {
    $id = ($projs | Where-Object { $_.name -eq $c.project }).id
    Invoke-RestMethod -Uri "$base/api/projects/$id/activate" -Method Post -TimeoutSec 900 | Out-Null

    $raw  = Invoke-WebRequest -Uri "$base/api/chat" -Method Post -ContentType 'application/json' `
              -Body (@{ agentId=$c.agent; message=$c.task } | ConvertTo-Json) -TimeoutSec 1800
    $text = if ($raw.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($raw.Content) } else { $raw.Content }
    $text | Out-File "$out\$($c.id)-$($c.project)-$($c.agent).ndjson" -Encoding utf8

    # what golden items did it actually open?
    $read = @()
    $answer = ""
    foreach ($line in ($text -split "`n" | Where-Object { $_.Trim() })) {
      try { $e = $line | ConvertFrom-Json } catch { continue }
      if ($e.type -eq 'tool_call' -and $e.name -eq 'golden_read') { $read += [string]$e.input.id }
      if ($e.type -eq 'text_delta') { $answer += [string]$e.text }
    }
    $read = $read | Where-Object { $_ } | Select-Object -Unique
    $row.goldenRead = ($read -join ",")
    $row.cited      = if ($answer -match '(GLD-[A-Z]+-\d+)@\d+') { $Matches[1] + "@v" } else { "" }
    $row.blocked    = if ($text -match 'BLOCKED — the artifact was NOT saved') { "YES" } else { "no" }

    if ($c.expect -eq "(none)") {
      $row.verdict = if ($read.Count -eq 0 -and -not $row.cited) { "PASS" } else { "REVIEW" }
      $row.note    = if ($row.verdict -eq "PASS") { "correctly did not force a citation" } else { "opened/cited: $($row.goldenRead) $($row.cited)" }
    } else {
      $row.verdict = if ($read -contains $c.expect) { "PASS" } else { "FAIL" }
      $row.note    = if ($row.verdict -eq "PASS") { "opened the expected item" } else { "expected $($c.expect), opened: $($row.goldenRead)" }
    }
    $answer | Out-File "$out\$($c.id)-answer.md" -Encoding utf8
    Write-Host "    -> $($row.verdict)  read=[$($row.goldenRead)] cited=$($row.cited) blocked=$($row.blocked)" `
               -ForegroundColor $(if ($row.verdict -eq 'PASS') { 'Green' } else { 'Yellow' })
  } catch {
    $row.verdict = "ERROR"; $row.note = $_.Exception.Message
    Write-Host "    -> ERROR $($_.Exception.Message)" -ForegroundColor Red
  }
  $rows += [pscustomobject]$row
}

$rows | Export-Csv "C:\Users\swarupd\demo\AgenticOS\test-evidence\2026-07-26\04-golden-agent-runs.csv" -NoTypeInformation
"`n"; $rows | Format-Table case,project,agent,expected,goldenRead,cited,blocked,verdict -AutoSize | Out-String -Width 250
