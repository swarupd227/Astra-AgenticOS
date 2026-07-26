# Tier 1: add a public repo per supported language, index it, and record what the
# platform actually saw. No LLM involved — this isolates indexer behaviour from
# agent behaviour, so a failure here is unambiguously an indexing defect.
$ErrorActionPreference = "Continue"
$base = "http://localhost:5173"
$out  = "C:\Users\swarupd\demo\AgenticOS\test-evidence\2026-07-26"

$repos = @(
  @{ n="petclinic-java";   u="https://github.com/spring-projects/spring-petclinic";              lang="Java / Spring Boot" }
  @{ n="flask-python";     u="https://github.com/pallets/flask";                                 lang="Python" }
  @{ n="angular-realworld";u="https://github.com/gothinkster/angular-realworld-example-app";     lang="TypeScript / Angular" }
  @{ n="react-realworld";  u="https://github.com/gothinkster/react-redux-realworld-example-app"; lang="JavaScript / React" }
  @{ n="gin-go";           u="https://github.com/gin-gonic/gin";                                 lang="Go" }
  @{ n="sinatra-ruby";     u="https://github.com/sinatra/sinatra";                               lang="Ruby" }
  @{ n="slim-php";         u="https://github.com/slimphp/Slim";                                  lang="PHP" }
  @{ n="miniredis-rust";   u="https://github.com/tokio-rs/mini-redis";                           lang="Rust" }
  @{ n="jq-c";             u="https://github.com/jqlang/jq";                                     lang="C" }
  @{ n="nlohmann-cpp";     u="https://github.com/nlohmann/json";                                 lang="C++" }
  @{ n="oslib-scala";      u="https://github.com/com-lihaoyi/os-lib";                            lang="Scala" }
)

$results = @()
foreach ($r in $repos) {
  Write-Host "`n=== $($r.n)  [$($r.lang)] ===" -ForegroundColor Cyan
  $row = [ordered]@{ project=$r.n; language=$r.lang; repo=$r.u; added=""; indexed=""; overview=""; issue="" }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $body = @{ name=$r.n; type="git"; repoUrl=$r.u } | ConvertTo-Json
    $add  = Invoke-RestMethod -Uri "$base/api/projects" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 900
    if (-not $add.ok) { throw ($add.error ?? "add failed") }
    $row.added = "ok ($([int]$sw.Elapsed.TotalSeconds)s)"
    $id = $add.project.id

    Invoke-RestMethod -Uri "$base/api/projects/$id/activate" -Method Post -TimeoutSec 900 | Out-Null

    $ov = Invoke-RestMethod -Uri "$base/api/tool" -Method Post -ContentType 'application/json' `
            -Body (@{ name="solution_overview"; arguments=@{} } | ConvertTo-Json) -TimeoutSec 900
    $txt = [string]$ov.result
    $row.indexed  = "ok"
    $row.overview = ($txt -split "`n" | Where-Object { $_ -match 'file|symbol|project|module|indexed' } | Select-Object -First 6) -join " | "
    $txt | Out-File "$out\overview-$($r.n).txt" -Encoding utf8
    Write-Host ($row.overview) -ForegroundColor Green
  } catch {
    $row.issue = $_.Exception.Message
    Write-Host "ISSUE: $($row.issue)" -ForegroundColor Red
  }
  $results += [pscustomobject]$row
}

$results | Export-Csv "$out\02-indexing-sweep.csv" -NoTypeInformation
$results | Format-Table project,language,added,indexed,issue -AutoSize | Out-String -Width 250
