# Start the full Decizense dev stack on Windows/PowerShell.
#
#   harness (http://127.0.0.1:9080/mcp)
#   backend (http://localhost:5005)
#   frontend (http://localhost:3000)
#
# Usage (from repo root):
#   pwsh scripts\dev-all.ps1
#   pwsh scripts\dev-all.ps1 -SkipDocker    # assume containers are already healthy
#
# Ctrl+C stops everything.

[CmdletBinding()]
param(
    [switch]$SkipDocker
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $RepoRoot

function Write-Step($msg) { Write-Host "[dev-all] $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "[dev-all] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[dev-all] $msg" -ForegroundColor Red }

function Wait-Http {
    param([string]$Url, [int]$TimeoutSec = 60, [string]$Method = 'GET', [hashtable]$Headers, [string]$Body)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $params = @{ Uri = $Url; Method = $Method; TimeoutSec = 2; UseBasicParsing = $true }
            if ($Headers) { $params.Headers = $Headers }
            if ($Body)    { $params.Body = $Body; $params.ContentType = 'application/json' }
            $null = Invoke-WebRequest @params
            return $true
        } catch { Start-Sleep -Milliseconds 500 }
    }
    return $false
}

function Ensure-Containers {
    if ($SkipDocker) { Write-Warn 'skipping docker checks (-SkipDocker)'; return }

    Write-Step 'ensuring travel_postgres + OPA are running'
    try { docker start travel_postgres *> $null } catch {}

    # Tutorial mandates recreating OPA from this repo so /policy mount is correct.
    docker compose -f docker/docker-compose.opa.yml up -d --force-recreate | Out-Null

    if (-not (Wait-Http -Url 'http://127.0.0.1:8181/health' -TimeoutSec 30)) {
        throw "OPA not reachable on :8181. Is Docker Desktop running? After a 'wsl --shutdown' you must recreate: docker compose -f docker/docker-compose.opa.yml up -d --force-recreate"
    }
    Write-Step 'OPA healthy on :8181'

    # travel_postgres readiness (it serves on :5433 mapped to container :5432)
    $tries = 0
    while ($tries -lt 30) {
        $ok = docker exec travel_postgres pg_isready -U travel_admin -d travel_db 2>$null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Milliseconds 500
        $tries++
    }
    if ($LASTEXITCODE -ne 0) { throw 'travel_postgres not healthy on :5433' }
    Write-Step 'travel_postgres healthy on :5433'
}

function Free-Port {
    param([int]$Port)
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop; Write-Warn "killed PID $($c.OwningProcess) on :$Port" } catch {}
    }
}

function Start-Harness {
    Write-Step 'starting harness on :9080'
    Free-Port 9080
    $env:HARNESS_TRANSPORT = 'http'
    $env:HARNESS_ALLOW_INSECURE_CONFIG_ONLY = 'true'
    $env:HARNESS_BIND = '127.0.0.1'
    $env:HARNESS_HTTP_PORT = '9080'
    $env:SCENARIO_PATH = '../scenario/travel'

    $logPath = Join-Path $RepoRoot '.harness.log'
    if (Test-Path $logPath) { Remove-Item $logPath -Force }

    $proc = Start-Process -FilePath 'npx.cmd' -ArgumentList 'tsx','src/server.ts' `
        -WorkingDirectory (Join-Path $RepoRoot 'harness') `
        -RedirectStandardOutput $logPath -RedirectStandardError (Join-Path $RepoRoot '.harness.err.log') `
        -NoNewWindow -PassThru

    $probeBody = '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"dev-all","version":"0.1"}}}'
    $probeHeaders = @{ 'Accept' = 'application/json, text/event-stream'; 'X-Agent-Id' = 'flight_ops' }
    if (-not (Wait-Http -Url 'http://127.0.0.1:9080/mcp' -Method 'POST' -Headers $probeHeaders -Body $probeBody -TimeoutSec 120)) {
        Write-Err 'harness did not become ready; last 30 lines of .harness.log:'
        if (Test-Path $logPath) { Get-Content $logPath -Tail 30 }
        throw 'harness startup failed'
    }
    Write-Step "harness ready (PID $($proc.Id))"
    return $proc
}

function Start-DevStack {
    Write-Step 'starting backend + frontend (npm run dev)'
    Free-Port 5005
    Free-Port 3000
    $logPath = Join-Path $RepoRoot '.dev-stack.log'
    if (Test-Path $logPath) { Remove-Item $logPath -Force }
    return Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev' `
        -WorkingDirectory $RepoRoot `
        -RedirectStandardOutput $logPath -RedirectStandardError (Join-Path $RepoRoot '.dev-stack.err.log') `
        -NoNewWindow -PassThru
}

$harnessProc = $null
$stackProc   = $null

try {
    Ensure-Containers
    $harnessProc = Start-Harness
    $stackProc   = Start-DevStack

    if (Wait-Http -Url 'http://127.0.0.1:5005/' -TimeoutSec 60) {
        Write-Step 'backend responding on :5005'
    } else {
        Write-Warn 'backend slow to respond; check .dev-stack.log'
    }
    if (Wait-Http -Url 'http://localhost:3000/' -TimeoutSec 60) {
        Write-Step 'frontend responding on :3000'
    } else {
        Write-Warn 'frontend slow to respond; check .dev-stack.log'
    }

    Write-Host ''
    Write-Host 'Ready:' -ForegroundColor Green
    Write-Host '  http://localhost:3000    (UI)'
    Write-Host '  http://localhost:5005    (backend)'
    Write-Host '  http://localhost:9080/mcp (harness)'
    Write-Host ''
    Write-Host 'Logs: .harness.log  .dev-stack.log'
    Write-Host 'Ctrl+C to stop all.'

    while ($true) {
        if ($harnessProc.HasExited) { Write-Err 'harness exited'; break }
        if ($stackProc.HasExited)   { Write-Err 'dev stack exited'; break }
        Start-Sleep -Seconds 2
    }
}
finally {
    Write-Step 'stopping...'
    foreach ($p in @($stackProc, $harnessProc)) {
        if ($p -and -not $p.HasExited) {
            try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
    # Clean any stragglers holding our ports (bun/vite child processes)
    Free-Port 3000
    Free-Port 5005
    Free-Port 9080
    Write-Step 'done'
}
