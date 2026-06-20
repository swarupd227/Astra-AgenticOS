<#
  setup.ps1 — one-shot setup for the CommerzBank SDLC-agents demo.

  1. Clones the demo codebase (nopCommerce 3.90, .NET Framework 4.5.1 / ASP.NET MVC).
  2. Builds the SDLC MCP server (Release) so VS Code Copilot can launch it instantly.

  Run from the repo root:  ./scripts/setup.ps1
#>

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$demoDir = Join-Path $repoRoot 'demo/nopCommerce'

Write-Host '== 1/2  Demo codebase ==' -ForegroundColor Cyan
if (Test-Path (Join-Path $demoDir 'src/NopCommerce.sln')) {
    Write-Host "nopCommerce already present at $demoDir — skipping clone."
} else {
    Write-Host 'Cloning nopCommerce release-3.90 (shallow)...'
    git clone --depth 1 --branch release-3.90 https://github.com/nopSolutions/nopCommerce.git $demoDir
}

Write-Host ''
Write-Host '== 2/2  Build MCP server (Release) ==' -ForegroundColor Cyan
dotnet build "$repoRoot/src/SdlcAgents.Mcp/SdlcAgents.Mcp.csproj" -c Release -nologo

Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
Write-Host 'Next:'
Write-Host '  1. Open this folder in VS Code.'
Write-Host '  2. Copilot Chat will discover .vscode/mcp.json — start the "sdlc-agents" server if prompted.'
Write-Host '  3. Pick an agent in the chat agent picker and follow docs/DEMO-SCRIPT.md.'
