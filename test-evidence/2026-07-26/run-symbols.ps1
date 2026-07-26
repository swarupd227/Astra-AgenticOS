# Tier 1b: prove each language indexer extracts real symbols, not just file counts.
# A known type/function is looked up per repo; a MISS means that language's parser
# is not producing declarations even though the files were counted.
$ErrorActionPreference = "Continue"
$base = "http://localhost:5173"
$out  = "C:\Users\swarupd\demo\AgenticOS\test-evidence\2026-07-26"

$checks = @(
  @{ p="petclinic-java";    lang="Java";       sym="OwnerController" }
  @{ p="flask-python";      lang="Python";     sym="Flask" }
  @{ p="angular-realworld"; lang="TypeScript"; sym="ArticleService" }
  @{ p="react-realworld";   lang="JavaScript"; sym="ArticleList" }
  @{ p="gin-go";            lang="Go";         sym="RouterGroup" }
  @{ p="sinatra-ruby";      lang="Ruby";       sym="Sinatra" }
  @{ p="slim-php";          lang="PHP";        sym="App" }
  @{ p="miniredis-rust";    lang="Rust";       sym="Connection" }
  @{ p="jq-c";              lang="C";          sym="jv_parse" }
  @{ p="nlohmann-cpp";      lang="C++";        sym="json_pointer" }
  @{ p="oslib-scala";       lang="Scala";      sym="Path" }
)

$projs = (Invoke-RestMethod "$base/api/projects").projects
$rows = @()
foreach ($c in $checks) {
  $id = ($projs | Where-Object { $_.name -eq $c.p }).id
  $row = [ordered]@{ project=$c.p; language=$c.lang; symbol=$c.sym; files=""; result=""; detail="" }
  try {
    Invoke-RestMethod -Uri "$base/api/projects/$id/activate" -Method Post -TimeoutSec 600 | Out-Null

    $ov = [string](Invoke-RestMethod -Uri "$base/api/tool" -Method Post -ContentType 'application/json' `
            -Body (@{name="solution_overview"; arguments=@{}} | ConvertTo-Json) -TimeoutSec 600).result
    if ($ov -match 'Indexed source files:\s*(\d+)') { $row.files = $Matches[1] }

    $fs = [string](Invoke-RestMethod -Uri "$base/api/tool" -Method Post -ContentType 'application/json' `
            -Body (@{name="find_symbol"; arguments=@{name=$c.sym}} | ConvertTo-Json) -TimeoutSec 600).result
    $fs | Out-File "$out\symbol-$($c.p).txt" -Encoding utf8
    if ($fs -match 'No declarations found') {
      $row.result = "MISS"; $row.detail = "no declaration extracted"
    } else {
      $row.result = "HIT"
      $row.detail = (($fs -split "`n" | Where-Object { $_ -match '^\-\s\*\*' } | Select-Object -First 1) -replace '\s+',' ').Trim()
    }
  } catch { $row.result = "ERROR"; $row.detail = $_.Exception.Message }
  $rows += [pscustomobject]$row
  "{0,-18} {1,-11} {2,-6} {3,-5} {4}" -f $c.p, $c.lang, $row.files, $row.result, $row.detail.Substring(0,[Math]::Min(80,$row.detail.Length))
}
$rows | Export-Csv "$out\03-symbol-extraction.csv" -NoTypeInformation
