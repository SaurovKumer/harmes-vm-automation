# Hermes one-shot production activation. Run locally in PowerShell.
# The secret is generated on this PC and streamed to the VM over SSH.
# Existing staging config is backed up on the VM; no secrets committed to Git.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$activeConfig = Join-Path $root "wrangler.activate.local.toml"
Push-Location $root
try {
    if (-not (Test-Path "wrangler.toml") -or -not (Test-Path "wrangler.recovery.toml")) {
        throw "Missing repository configuration; pull the feature branch first."
    }
    if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
        throw "Windows OpenSSH client is missing."
    }
    if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) {
        throw "Node.js/npm is not available."
    }
    $originalConfig = [IO.File]::ReadAllText((Join-Path $root "wrangler.toml"))
    $flag = 'SMART_DEALLOCATE_ENABLED\s*=\s*"false"'
    if (-not [regex]::IsMatch($originalConfig, $flag)) {
        throw "Smart flag must initially be set to false in wrangler.toml."
    }

    Write-Host ""
    Write-Host "ONE-SHOT: Hermes -> Cloudflare PRODUCTION -> Azure DEAllocate" -ForegroundColor Cyan
    Write-Host "Smart Deallocate will be turned on only AFTER verified Hermes delivery."
    Write-Host "Please finish current Hermes tasks before continuing." -ForegroundColor Yellow
    $ready = Read-Host "Type YES if Hermes is idle and you want to ACTIVATE Smart Deallocate"
    if ($ready -cne "YES") {
        throw "Cancelled: no changes made."
    }
    $target = (Read-Host "Azure VM SSH destination (azureuser@public-IP or SSH alias)").Trim()
    if ($target -notmatch '^[a-zA-Z0-9_.@:\-\[\]]+$' -or $target.StartsWith("-")) {
        throw "Invalid SSH destination."
    }
    $keyPath = (Read-Host "SSH private key path (leave blank if configured in SSH agent)").Trim().Trim('"')
    $sshArgs = @("-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=10")
    if ($keyPath) {
        $keyPath = [Environment]::ExpandEnvironmentVariables($keyPath)
        if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
            throw "SSH private key file not found."
        }
        $sshArgs += @("-i", $keyPath)
    }
    $sshArgs += @($target)

    Write-Host "[1/4] Checking VM and Hermes Gateway..." -ForegroundColor Cyan
    & ssh @sshArgs "test -f ~/.hermes/vm-task-monitor.json && test -f ~/.hermes/hooks/vm-task-monitor/handler.py && command -v python3 >/dev/null && systemctl --user is-active --quiet hermes-gateway.service"
    if ($LASTEXITCODE -ne 0) {
        throw "VM SSH / Hermes Gateway check failed; Cloudflare has NOT been changed."
    }

    Write-Host "[2/4] Creating secret directly in Cloudflare production..." -ForegroundColor Cyan
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $secret = [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
    $secret | & npx.cmd wrangler secret put HERMES_EVENT_SECRET --config wrangler.toml
    if ($LASTEXITCODE -ne 0) {
        throw "Cloudflare secret update failed; smart mode remains OFF."
    }

    Write-Host "[3/4] Connecting Hermes to production and verifying signed events..." -ForegroundColor Cyan
    $publicUrl = "https://harmes-vm-automation.saurovkumar07.workers.dev"
    $settings = @{ worker_url = $publicUrl; secret = $secret } | ConvertTo-Json -Compress
    $settingsB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($settings))
    $remotePython = @'
import asyncio
import base64
import hmac
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import uuid

settings = json.loads(base64.b64decode("PRIVATE_CONFIG_B64"))
home = Path.home() / ".hermes"
path = home / "vm-task-monitor.json"
backup = home / "vm-task-monitor.before-production.json"
old = path.read_bytes()

def status():
    token = hmac.new(
        settings["secret"].encode(),
        ("status:" + str(int(time.time() // 60))).encode(),
        hashlib.sha256
    ).hexdigest()
    req = urllib.request.Request(
        settings["worker_url"].rstrip("/") + "/hermes-status",
        headers={
            "User-Agent": "Hermes-Task-Monitor/1.0",
            "X-Hermes-Status-Token": token
        }
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.load(response)

try:
    backup.write_bytes(old)
    os.chmod(backup, 0o600)
    config = json.loads(old)
    config["worker_url"] = settings["worker_url"]
    config["secret"] = settings["secret"]
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)
    subprocess.run(
        ["systemctl", "--user", "restart", "hermes-gateway.service"],
        check=True
    )
    before = status()
    count = int(before.get("receivedCount", 0))

    # Verify real hook->HTTP transport without asking user to run more tests.
    hook = home / "hooks" / "vm-task-monitor" / "handler.py"
    spec = importlib.util.spec_from_file_location("hermes_prod_bridge_check", str(hook))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    session = "production-setup-check-" + uuid.uuid4().hex
    async def transmit():
        await module.handle("agent:start", {"session_id": session})
        await module.handle("agent:end", {"session_id": session})
    asyncio.run(transmit())
    after = status()
    if int(after.get("receivedCount", 0)) < count + 2:
        raise RuntimeError("Signed Hermes events not confirmed by production Worker")
    if int(after.get("activeCount", 0)) != 0:
        raise RuntimeError("Active task detected. Refusing to enable Smart Deallocate.")
    if not after.get("managed"):
        raise RuntimeError("Task tracker is not yet initialized")
    print("Bridge verified: authenticated Hermes start/end successfully received.")
except Exception:
    path.write_bytes(old)
    os.chmod(path, 0o600)
    subprocess.run(
        ["systemctl", "--user", "restart", "hermes-gateway.service"],
        check=False
    )
    raise RuntimeError("Production connection failed; Hermes staging config restored.")
'@
    $remotePython = $remotePython.Replace("PRIVATE_CONFIG_B64", $settingsB64)
    $remotePython | & ssh @sshArgs "python3 -"
    if ($LASTEXITCODE -ne 0) {
        throw "Hermes production bridge failed; Smart Deallocate remains OFF."
    }

    Write-Host "[4/4] Activating Smart Auto-DEALLOCATE in production..." -ForegroundColor Cyan
    # Use a temporary Wrangler config so committed 'false' safety default remains intact.
    $enabledConfig = [regex]::Replace(
        $originalConfig,
        $flag,
        'SMART_DEALLOCATE_ENABLED = "true"'
    )
    [IO.File]::WriteAllText(
        $activeConfig, $enabledConfig, [System.Text.UTF8Encoding]::new($false)
    )
    & npx.cmd wrangler deploy --config $activeConfig
    if ($LASTEXITCODE -ne 0) {
        throw "Cloudflare activation deploy failed. Check its output; do not assume active."
    }

    Write-Host ""
    Write-Host "SUCCESS: Production Hermes connected and Smart Auto-DEALLOCATE activated." -ForegroundColor Green
    Write-Host "Automatic policy: active task protected; 30min idle; 5min Telegram confirmation; Keep Alive +15min."
    Write-Host "No OS shutdown command is used: Azure Compute /deallocate API only."
    Write-Host "Telegram /status should say Smart auto-deallocation: ENABLED."
    Write-Host "Recovery: npx.cmd wrangler deploy --config wrangler.recovery.toml"
} catch {
    Write-Host ""
    Write-Host ("SETUP STOPPED: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host "If stopped before [4/4], Smart Auto-Deallocation remains OFF."
    Write-Host "Recovery: npx.cmd wrangler deploy --config wrangler.recovery.toml"
    exit 1
} finally {
    if (Test-Path -LiteralPath $activeConfig) {
        Remove-Item -LiteralPath $activeConfig -Force
    }
    Pop-Location
}
