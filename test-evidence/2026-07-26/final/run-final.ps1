# Final end-to-end: varied agents, varied languages, real published guidelines.
# Also a deliberate load test — the Ruby (147 KB) and Airbnb (130 KB) guides are far
# larger than anything used so far, and golden_read returns a whole document.
$ErrorActionPreference = "Continue"
$base = "http://localhost:5173"
$out  = "C:\Users\swarupd\demo\AgenticOS\test-evidence\2026-07-26\final\runs"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$cases = @(
  @{ id="R1"; p="gin-go";            a="code-reviewer";          want="GLD-STD-003"; kb=89
     t="Review the routing and middleware code for style and error-handling problems. Apply our Go standard." }
  @{ id="R2"; p="flask-python";      a="code-reviewer";          want="GLD-STD-005"; kb=50
     t="Review the app and blueprint modules for naming and layout issues against our Python standard." }
  @{ id="R3"; p="slim-php";          a="code-reviewer";          want="GLD-STD-004"; kb=27
     t="Review the App and middleware classes for compliance with our PHP coding standard." }
  @{ id="R4"; p="sinatra-ruby";      a="code-reviewer";          want="GLD-STD-006"; kb=147
     t="Review lib/sinatra/base.rb for style problems against our Ruby standard." }
  @{ id="R5"; p="miniredis-rust";    a="code-reviewer";          want="GLD-CHK-002"; kb=7
     t="Review the public API surface of this crate against our Rust API guidelines." }
  @{ id="R6"; p="react-realworld";   a="frontend-architecture";  want="GLD-STD-008"; kb=130
     t="Map this React app's structure and flag where it departs from our JavaScript standard." }
  @{ id="R7"; p="petclinic-java";    a="config-secrets-auditor"; want="GLD-STD-010"; kb=64
     t="Audit this Spring Boot app for hardcoded secrets and unsafe configuration, using our secrets standard." }
  @{ id="R8"; p="gin-go";            a="security-threat";        want="GLD-STD-009"; kb=29
     t="What logging risks does this Go service have? Apply our logging standard." }
  @{ id="R9"; p="angular-realworld"; a="code-reviewer";          want="(isolation)"; kb=0
     t="Review the auth service against our organisation's TypeScript coding standard." }
)

$rows = @()
foreach ($c in $cases) {
  Write-Host "`n=== $($c.id)  $($c.p) / $($c.a)  (expect $($c.want), $($c.kb) KB) ===" -ForegroundColor Cyan
  $row = [ordered]@{ case=$c.id; project=$c.p; agent=$c.a; expected=$c.want; docKB=$c.kb
                     secs=""; goldenRead=""; cited=""; errors=""; verdict=""; note="" }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $id = ((Invoke-RestMethod "$base/api/projects").projects | Where-Object { $_.name -eq $c.p }).id
    Invoke-RestMethod -Uri "$base/api/projects/$id/activate" -Method Post -TimeoutSec 1200 | Out-Null

    $raw  = Invoke-WebRequest -Uri "$base/api/chat" -Method Post -ContentType 'application/json' `
              -Body (@{ agentId=$c.a; message=$c.t } | ConvertTo-Json) -TimeoutSec 2400
    $text = if ($raw.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($raw.Content) } else { $raw.Content }
    $text | Out-File "$out\$($c.id)-$($c.p)-$($c.a).ndjson" -Encoding utf8
    $row.secs = [int]$sw.Elapsed.TotalSeconds

    $read = @(); $answer = ""; $errs = @()
    foreach ($line in ($text -split "`n" | Where-Object { $_.Trim() })) {
      try { $e = $line | ConvertFrom-Json } catch { continue }
      if ($e.type -eq 'tool_call' -and $e.name -eq 'golden_read') { $read += [string]$e.input.id }
      if ($e.type -eq 'text_delta') { $answer += [string]$e.text }
      if ($e.type -eq 'error') { $errs += [string]$e.message }
    }
    if ($text -match 'max_tokens') { $errs += "max_tokens truncation" }
    $read = $read | Where-Object { $_ } | Select-Object -Unique
    $row.goldenRead = ($read -join ",")
    $row.errors     = ($errs -join " | ")
    $cites = [regex]::Matches($answer, 'GLD-[A-Z]+-\d+@\d+') | ForEach-Object { $_.Value } | Select-Object -Unique
    $row.cited = ($cites -join ",")
    $answer | Out-File "$out\$($c.id)-answer.md" -Encoding utf8

    if ($c.want -eq "(isolation)") {
      # No TypeScript guide exists. Passing means NOT inventing one and NOT reaching
      # a document this project was never given.
      $badRead = $read | Where-Object { $_ -notin @("GLD-STD-009","GLD-STD-010") }
      $row.verdict = if (-not $badRead) { "PASS" } else { "FAIL" }
      $row.note = if (-not $badRead) { "did not reach outside its selection" } else { "reached $($badRead -join ',')" }
    } else {
      $row.verdict = if ($read -contains $c.want) { "PASS" } else { "FAIL" }
      $row.note    = if ($read -contains $c.want) { "read the expected guide" } else { "expected $($c.want), read: $($row.goldenRead)" }
    }
    if ($errs) { $row.verdict = "$($row.verdict)/ERR" }
    Write-Host "    -> $($row.verdict)  $($row.secs)s  read=[$($row.goldenRead)] cited=[$($row.cited)] $(if($errs){"ERRORS: $($row.errors)"})" `
               -ForegroundColor $(if ($row.verdict -eq 'PASS') { 'Green' } else { 'Yellow' })
  } catch {
    $row.verdict="ERROR"; $row.note=$_.Exception.Message; $row.secs=[int]$sw.Elapsed.TotalSeconds
    Write-Host "    -> ERROR $($_.Exception.Message)" -ForegroundColor Red
  }
  $rows += [pscustomobject]$row
}
$rows | Export-Csv "C:\Users\swarupd\demo\AgenticOS\test-evidence\2026-07-26\final\02-final-runs.csv" -NoTypeInformation
"`n"; $rows | Format-Table case,project,agent,docKB,secs,goldenRead,cited,verdict -AutoSize | Out-String -Width 250
