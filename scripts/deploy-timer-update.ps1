# Deploy the 10-minute timer update without re-running production secret setup.
# Safeguard: choose the Smart Mode shown in the live Telegram /status response.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Enabled", "Disabled")]
    [string]$SmartMode
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tempConfig = Join-Path $root "wrangler.timer-update.local.toml"
Push-Location $root
try {
    if (-not (Test-Path "wrangler.toml")) {
        throw "wrangler.toml not found."
    }
    $original = [IO.File]::ReadAllText((Join-Path $root "wrangler.toml"))
    $flagPattern = 'SMART_DEALLOCATE_ENABLED\s*=\s*"false"'
    if (-not [regex]::IsMatch($original, $flagPattern)) {
        throw "Expected checked-in safety default SMART_DEALLOCATE_ENABLED=false."
    }
    Write-Host "Running syntax and integration tests before deploy..." -ForegroundColor Cyan
    & node --check src/index.js
    if ($LASTEXITCODE -ne 0) { throw "index.js syntax check failed. NOT deploying." }
    & node --check src/hermes-task-state.js
    if ($LASTEXITCODE -ne 0) { throw "HermesTaskState syntax check failed. NOT deploying." }
    & node --test tests/hermes-task-state.test.mjs tests/smart-shutdown-dry-run.test.mjs
    if ($LASTEXITCODE -ne 0) { throw "Tests failed. NOT deploying." }

    $deployConfig = (Join-Path $root "wrangler.toml")
    if ($SmartMode -eq "Enabled") {
        $enabled = [regex]::Replace(
            $original, $flagPattern, 'SMART_DEALLOCATE_ENABLED = "true"'
        )
        [IO.File]::WriteAllText(
            $tempConfig, $enabled, [Text.UTF8Encoding]::new($false)
        )
        $deployConfig = $tempConfig
    }
    Write-Host "Ready to deploy the 10-minute timer update." -ForegroundColor Yellow
    Write-Host "The deployed Smart Mode will be: $SmartMode"
    $confirmation = Read-Host "Type DEPLOY to update the PRODUCTION Worker"
    if ($confirmation -cne "DEPLOY") {
        throw "Cancelled. No production deployment performed."
    }
    & npx.cmd wrangler deploy --dry-run --config $deployConfig
    if ($LASTEXITCODE -ne 0) { throw "Wrangler dry-run failed. NOT deploying." }
    & npx.cmd wrangler deploy --config $deployConfig
    if ($LASTEXITCODE -ne 0) { throw "Wrangler deploy failed. Inspect live deployment status." }
    Write-Host "SUCCESS: Timer update deployed. Expected Smart Mode: $SmartMode." -ForegroundColor Green
    Write-Host "Telegram /status should confirm actual production mode."
    Write-Host "New policy: 10 minutes total; warning ~5 minutes before deallocate."
    Write-Host "Existing VM timers and stored Hermes idle deadlines may retain old absolute times until a fresh lifecycle begins."
} catch {
    Write-Host ("STOPPED: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if (Test-Path -LiteralPath $tempConfig) {
        Remove-Item -LiteralPath $tempConfig -Force
    }
    Pop-Location
}
