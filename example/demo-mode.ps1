<#
.SYNOPSIS
    Switch dazense governance level for demo purposes.
.DESCRIPTION
    Toggles between three governance modes by renaming config files.
    Start a new chat after switching for the change to take effect.
    No server restart needed.
.EXAMPLE
    .\demo-mode.ps1 none       # No governance — raw SQL agent, no rules, no semantic layer
    .\demo-mode.ps1 semantic   # Semantic layer only — business rules + metrics (soft guidance)
    .\demo-mode.ps1 full       # Full V1 — contracts, policy enforcement, PII blocking (hard enforcement)
    .\demo-mode.ps1            # Show current mode
#>

param(
    [ValidateSet("none", "semantic", "full", "")]
    [string]$Mode = ""
)

$exampleDir = $PSScriptRoot
$policyFile   = Join-Path $exampleDir "policies\policy.yml"
$policyBak    = Join-Path $exampleDir "policies\policy.yml.bak"
$rulesFile    = Join-Path $exampleDir "semantics\business_rules.yml"
$rulesBak     = Join-Path $exampleDir "semantics\business_rules.yml.bak"
$semanticFile = Join-Path $exampleDir "semantics\semantic_model.yml"
$semanticBak  = Join-Path $exampleDir "semantics\semantic_model.yml.bak"
$bundleDir    = Join-Path $exampleDir "datasets\jaffle_shop"
$bundleBak    = Join-Path $exampleDir "datasets\jaffle_shop.bak"

function Get-CurrentMode {
    $hasPolicy   = Test-Path $policyFile
    $hasRules    = Test-Path $rulesFile
    $hasSemantic = Test-Path $semanticFile
    $hasBundle   = Test-Path $bundleDir

    if ($hasPolicy -and $hasRules -and $hasSemantic -and $hasBundle) { return "full" }
    if ($hasSemantic -and $hasRules -and -not $hasPolicy)            { return "semantic" }
    return "none"
}

function Enable-File($active, $backup) {
    if ((Test-Path $backup) -and -not (Test-Path $active)) {
        Rename-Item $backup (Split-Path $active -Leaf)
    }
}

function Disable-File($active, $backup) {
    if (Test-Path $active) {
        Rename-Item $active (Split-Path $backup -Leaf)
    }
}

# Show current mode if no argument
if ($Mode -eq "") {
    $current = Get-CurrentMode
    Write-Host ""
    Write-Host "  Current mode: " -NoNewline
    switch ($current) {
        "none"     { Write-Host "NONE" -ForegroundColor Red -NoNewline; Write-Host " (no governance — raw SQL agent)" }
        "semantic" { Write-Host "SEMANTIC" -ForegroundColor Yellow -NoNewline; Write-Host " (business rules + metrics)" }
        "full"     { Write-Host "FULL" -ForegroundColor Green -NoNewline; Write-Host " (contracts + policy enforcement)" }
    }
    Write-Host ""
    Write-Host "  Usage: .\demo-mode.ps1 [none|semantic|full]"
    Write-Host ""
    exit
}

# Apply the requested mode
switch ($Mode) {
    "none" {
        Disable-File $policyFile   $policyBak
        Disable-File $rulesFile    $rulesBak
        Disable-File $semanticFile $semanticBak
        Disable-File $bundleDir    $bundleBak
    }
    "semantic" {
        Disable-File $policyFile   $policyBak
        Enable-File  $rulesFile    $rulesBak
        Enable-File  $semanticFile $semanticBak
        Enable-File  $bundleDir    $bundleBak
    }
    "full" {
        Enable-File $policyFile   $policyBak
        Enable-File $rulesFile    $rulesBak
        Enable-File $semanticFile $semanticBak
        Enable-File $bundleDir    $bundleBak
    }
}

$current = Get-CurrentMode
Write-Host ""
switch ($current) {
    "none" {
        Write-Host "  Mode: NONE" -ForegroundColor Red
        Write-Host "  No governance. Raw SQL agent — queries anything, returns PII, no limits."
        Write-Host ""
        Write-Host "  Disabled: semantic_model.yml, business_rules.yml, policy.yml, dataset bundle" -ForegroundColor DarkGray
    }
    "semantic" {
        Write-Host "  Mode: SEMANTIC" -ForegroundColor Yellow
        Write-Host "  Business rules + governed metrics active (soft guidance, LLM can still bypass)."
        Write-Host ""
        Write-Host "  Active:   semantic_model.yml, business_rules.yml, dataset bundle" -ForegroundColor DarkGray
        Write-Host "  Disabled: policy.yml" -ForegroundColor DarkGray
    }
    "full" {
        Write-Host "  Mode: FULL" -ForegroundColor Green
        Write-Host "  Contracts + policy enforcement (hard enforcement, PII blocked, joins validated)."
        Write-Host ""
        Write-Host "  Active: semantic_model.yml, business_rules.yml, policy.yml, dataset bundle" -ForegroundColor DarkGray
    }
}
Write-Host ""
Write-Host "  -> Start a NEW CHAT for the change to take effect." -ForegroundColor Cyan
Write-Host ""
