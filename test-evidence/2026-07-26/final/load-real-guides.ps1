# Loads REAL published engineering guidelines from public GitHub repositories into
# the Golden Repository, tagged by language, then scopes each project to its own
# language tag plus the shared security tag.
#
# This is the realistic shape of the feature: one shared library, many projects,
# each seeing only what applies to it. It also tests whether an agent working on a
# Go repo can be kept from reading the PHP standard.
$ErrorActionPreference = "Stop"
$base = "http://localhost:5173"
$g    = "C:\Users\swarupd\AppData\Local\Temp\claude\C--Users-swarupd-demo-AgenticOS\d2397ee9-7447-496a-b9ba-61852326c1f0\scratchpad\guides"

# Archive the synthetic items from the earlier round so results are attributable
# to the real documents alone.
foreach ($old in (Invoke-RestMethod "$base/api/golden").items | Where-Object { $_.status -ne 'archived' }) {
  Invoke-RestMethod -Uri "$base/api/golden/$($old.id)/archive" -Method Post | Out-Null
  "archived prior item $($old.id) — $($old.title)"
}

$guides = @(
  @{ file="$g\uber-go-guide\style.md";                                              tag="go"
     title="Uber Go Style Guide"; kind="standard"; enf="mandatory"
     desc="Uber's published Go style guide: interfaces, error handling, concurrency, performance and naming."
     aliases=@("go style","golang conventions","error wrapping"); owner="Uber (open source)"; approver="Platform Guild" }

  @{ file="$g\php-fig-fig-standards\accepted\PSR-12-extended-coding-style-guide.md"; tag="php"
     title="PSR-12 Extended Coding Style"; kind="standard"; enf="mandatory"
     desc="The PHP-FIG PSR-12 standard: file layout, namespaces, class and control-structure formatting."
     aliases=@("php standard","fig","psr"); owner="PHP-FIG"; approver="Platform Guild" }

  @{ file="$g\python-peps\peps\pep-0008.rst";                                        tag="python"
     title="PEP 8 — Style Guide for Python Code"; kind="standard"; enf="mandatory"
     desc="The Python style guide: layout, naming conventions, imports, comments and programming recommendations."
     aliases=@("pep8","python style","snake case"); owner="Python Software Foundation"; approver="Platform Guild" }

  @{ file="$g\rubocop-ruby-style-guide\README.adoc";                                 tag="ruby"
     title="Ruby Style Guide"; kind="standard"; enf="recommended"
     desc="The community Ruby style guide used by RuboCop: syntax, naming, classes, exceptions and collections."
     aliases=@("rubocop","ruby conventions"); owner="RuboCop community"; approver="" }

  @{ file="$g\rust-lang-api-guidelines\src\checklist.md";                            tag="rust"
     title="Rust API Guidelines Checklist"; kind="checklist"; enf="recommended"
     desc="The official Rust API design checklist: naming, interoperability, macros, documentation and future-proofing."
     aliases=@("rust api design","crate guidelines"); owner="Rust Library Team"; approver="" }

  @{ file="$g\dotnet-runtime\docs\coding-guidelines\coding-style.md";                tag="csharp"
     title=".NET Runtime C# Coding Style"; kind="standard"; enf="mandatory"
     desc="The dotnet/runtime C# coding style: braces, underscores on private fields, var usage, using order and spacing."
     aliases=@("c# style","dotnet conventions"); owner="Microsoft (dotnet/runtime)"; approver="Platform Guild" }

  @{ file="$g\airbnb-javascript\README.md";                                          tag="javascript"
     title="Airbnb JavaScript Style Guide"; kind="standard"; enf="recommended"
     desc="Airbnb's JavaScript/React style guide: references, objects, arrays, destructuring, classes, modules and hooks."
     aliases=@("airbnb js","es6 style","react conventions"); owner="Airbnb (open source)"; approver="" }

  @{ file="$g\OWASP-CheatSheetSeries\cheatsheets\Logging_Cheat_Sheet.md";            tag="security"
     title="OWASP Logging Cheat Sheet"; kind="standard"; enf="mandatory"
     desc="OWASP guidance on what to log, what must never be logged, and how to protect log integrity."
     aliases=@("logging rules","audit trail","what not to log"); owner="OWASP"; approver="Security Guild" }

  @{ file="$g\OWASP-CheatSheetSeries\cheatsheets\Secrets_Management_Cheat_Sheet.md"; tag="security"
     title="OWASP Secrets Management Cheat Sheet"; kind="standard"; enf="mandatory"
     desc="OWASP guidance on storing, rotating and detecting secrets, and on keeping credentials out of source."
     aliases=@("secrets","credentials","key rotation","hardcoded password"); owner="OWASP"; approver="Security Guild" }
)

$created = @()
foreach ($gd in $guides) {
  if (-not (Test-Path $gd.file)) { Write-Host "MISSING $($gd.file)" -ForegroundColor Red; continue }
  $content = Get-Content $gd.file -Raw
  $body = @{
    title=$gd.title; description=$gd.desc; kind=$gd.kind; enforcement=$gd.enf
    appliesTo=@("all"); tags=@($gd.tag); aliases=$gd.aliases
    owner=$gd.owner; status="published"
    sourceName=(Split-Path $gd.file -Leaf); content=$content
  }
  if ($gd.approver) { $body.approvedBy = $gd.approver }
  $item = (Invoke-RestMethod -Uri "$base/api/golden" -Method Post -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 6)).item
  $created += [pscustomobject]@{ id=$item.id; tag=$gd.tag; title=$item.title; kb=[math]::Round($item.contentChars/1024,1); enf=$item.enforcement }
  "{0,-14} {1,-11} {2,7} KB  {3}" -f $item.id, $gd.tag, [math]::Round($item.contentChars/1024,1), $item.title
}

$created | Export-Csv "C:\Users\swarupd\demo\AgenticOS\test-evidence\2026-07-26\final\01-real-guides-loaded.csv" -NoTypeInformation

# --- scope each project to its own language + the shared security tag ---
"`n--- per-project knowledge selection ---"
$map = @{ "gin-go"="go"; "slim-php"="php"; "flask-python"="python"; "sinatra-ruby"="ruby"
          "miniredis-rust"="rust"; "react-realworld"="javascript"; "angular-realworld"="typescript"
          "petclinic-java"="java" }
$projs = (Invoke-RestMethod "$base/api/projects").projects
foreach ($kv in $map.GetEnumerator()) {
  $p = $projs | Where-Object { $_.name -eq $kv.Key }
  if (-not $p) { "  (no project $($kv.Key))"; continue }
  $sel = @{ mode="subset"; itemIds=@(); tags=@($kv.Value,"security") } | ConvertTo-Json
  $r = Invoke-RestMethod -Uri "$base/api/projects/$($p.id)/golden" -Method Post -ContentType 'application/json' -Body $sel
  "{0,-20} tags=[{1}, security] -> {2} item(s) visible" -f $kv.Key, $kv.Value, $r.selectedCount
}
