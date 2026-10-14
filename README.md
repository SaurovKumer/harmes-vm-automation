# Harmes VM Automation

Cloudflare Worker + Telegram automation for safely operating an Azure Virtual Machine.

The current runtime is a **Cloudflare Worker + Telegram webhook + Azure APIs**. An optional **Hermes Gateway** bridge adds task-aware deallocation using HMAC-signed events and a Cloudflare Durable Object. GitHub stores the source. This feature-branch production rollout uses **Wrangler** from Windows PowerShell.

> Production Worker: [harmes-vm-automation](https://harmes-vm-automation.saurovkumar07.workers.dev)  
> Resource group: `harmes-vm_group` | VM: `harmes-vm` | Time zone: `Asia/Dhaka`  
> **Safe source default:** `SMART_DEALLOCATE_ENABLED = "false"` in `wrangler.toml`. The one-shot activation script can switch the *deployed* Worker to ON using a temporary config. Telegram `/status` shows the real live setting.

## Features

- Start the Azure VM from Telegram
- Deallocate the VM from Telegram
- Legacy 30-minute safety runtime after a VM start, when smart mode is OFF/uninitialized
- Optional Hermes task-aware idle tracking, 5-minute Telegram confirmation and Azure deallocation
- Warning about 5 minutes before automatic deallocation
- Runtime extension buttons: +30m, +1h, +2h, +3h, +4h
- Daily auto-start at a user-selected Bangladesh time
- Detect manual/external VM starts
- Detect manual/external VM deallocation
- Detect a VM that is only stopped and request full deallocation
- Show VM status and remaining runtime
- Show recent Azure costs
- Show an **estimated Azure for Students balance**
- Cloudflare scheduler runs every minute
- Dashboard variables are preserved across deploys with `keep_vars = true`

---

## Telegram commands

| Command | Description |
| --- | --- |
| `/status` | Show VM state, planned deallocation time, remaining runtime, and auto-start setting |
| `/startvm` | Start the VM and attach a 30-minute safety timer |
| `/deallocate` | Deallocate the VM immediately |
| `/shutdown` | Alias for `/deallocate` |
| `/keep30` | Extend runtime by 30 minutes |
| `/keep60` | Extend runtime by 1 hour |
| `/keep120` | Extend runtime by 2 hours |
| `/keep180` | Extend runtime by 3 hours |
| `/keep240` | Extend runtime by 4 hours |
| `/autostart HH:MM` | Set daily auto-start time in Bangladesh time |
| `/autostart` | Show current auto-start setting |
| `/autostart off` | Disable daily auto-start |
| `/cost1d` | Cost for the last 1 day |
| `/cost2d` | Cost for the last 2 days |
| `/cost3d` | Cost for the last 3 days |
| `/cost7d` | Cost for the last 7 days |
| `/cost30d` | Cost for the last 30 days |
| `/balance` | Estimated remaining Azure for Students credit |
| `/help` | Show available commands |

Example:

```text
/autostart 07:30
```

---

## Architecture

```text
Telegram --> HTTPS POST /telegram --> Cloudflare Worker --> Azure VM/Cost API
                                               |
Hermes Gateway --signed POST /hermes-event------+
                                               |
                                               v
                                  HERMES_TASK_STATE Durable Object
                                  (active sessions, heartbeat, idle deadline)

Cloudflare cron (* * * * *): daily auto-start and safety scheduling
  - Legacy 30-minute timer when smart mode is OFF or uninitialized
  - Task-aware idle/confirmation policy when enabled and managed
```

The Worker continues running in Cloudflare when your PC is off. An ordinary code deployment does not guarantee that smart mode is enabled.

## Important files

```text
README.md
src/
  index.js                 # Worker, Telegram commands, Azure API, cron
  hermes-task-state.js     # Durable Object / task state
  legacy-recovery.js       # Legacy behavior for recovery
scripts/
  setup-production.ps1     # One-shot production Hermes activation
wrangler.toml              # Worker config; smart mode defaults OFF
wrangler.recovery.toml     # Recovery entrypoint; smart mode OFF
```

The Worker name is `harmes-vm-automation`, the scheduled cron is `* * * * *`, and `HERMES_TASK_STATE` binds to SQLite-backed class `HermesTaskState` using migration `v1-hermes-task-state`. Both Wrangler configs use `keep_vars = true`.

## Current production rollout: one-shot setup

**Only activate when Hermes is idle.** You need Cloudflare Wrangler login, Node.js/npm, Windows OpenSSH, VM SSH key (or agent), and an active `hermes-gateway.service` with the task-monitor hook installed.

Run from your existing checked-out `feature/hermes-smart-task-design` working copy in PowerShell:

```powershell
cd C:\Users\sauro\hermes-staging
git pull --ff-only origin feature/hermes-smart-task-design
if ($LASTEXITCODE -eq 0) {
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-production.ps1
}
```

The script prompts for **uppercase `YES`** (lowercase `yes` cancels), then your SSH destination (e.g. `azureuser@<VM_PUBLIC_IP>`) and the private **key file path** (e.g. `C:\path\to\harmes-vm_key.pem`). Never paste the key *contents*.

The four stages are:
1. Verify SSH, Hermes Gateway service and installed task-monitor files.
2. Create a random 32-byte production `HERMES_EVENT_SECRET` and store it as a Cloudflare secret.
3. Back up `~/.hermes/vm-task-monitor.json` to `~/.hermes/vm-task-monitor.before-production.json`, point Hermes to the production Worker, restart the service, and verify real signed start/end event delivery.
4. **Only after verified delivery**, deploy the Worker with `SMART_DEALLOCATE_ENABLED = "true"` using temporary `wrangler.activate.local.toml`, which the script deletes after use.

Success message:

```text
SUCCESS: Production Hermes connected and Smart Auto-DEALLOCATE activated.
```

Then send **`/status`** to the Telegram bot to verify the deployed state:
- `Smart auto-deallocation: ENABLED` means task-aware scheduling is enabled.
- `Smart auto-deallocation: DISABLED (legacy timer)` means the 30-minute fallback runs instead.

The checked-in `wrangler.toml` deliberately stays at `false`. **Warning: running `npx.cmd wrangler deploy --config wrangler.toml` after activation deploys OFF and can disable smart mode.** Do not assume that a green health endpoint proves the bridge is functioning.

### Recovery option

If smart behavior is unsafe or broken, while Hermes is idle use the legacy recovery configuration:

```powershell
npx.cmd wrangler deploy --dry-run --config wrangler.recovery.toml
npx.cmd wrangler deploy --config wrangler.recovery.toml
```

This preserves the Durable Object *binding* in configuration and deploys the legacy code path. **It is a recovery option, not a guaranteed one-click rollback.** Durable Object migrations complicate ordinary version rollback, and dry-run checks building rather than live operation. Verify Telegram `/status` and VM control afterward. If activation fails before completion, check actual live state; do not assume partial Cloudflare/VM config changes were reversed.

# Setup

## 1. Requirements

You need:

- Azure subscription
- Azure VM
- Microsoft Entra app registration
- GitHub repository
- Cloudflare account
- Cloudflare Worker connected to the GitHub repository
- Telegram account
- Telegram bot created with BotFather

Azure for Students works with this project.

---

## 2. Azure app registration

Open:

**Azure Portal → Microsoft Entra ID → App registrations**

Create a new app, or use an existing app.

This project currently uses the existing app:

```text
github-harmes-vm
```

### Where to get the Azure IDs

Open:

**Microsoft Entra ID → App registrations → your app → Overview**

Copy:

### `AZURE_CLIENT_ID`

Use:

```text
Application (client) ID
```

### `AZURE_TENANT_ID`

Use:

```text
Directory (tenant) ID
```

### `AZURE_SUBSCRIPTION_ID`

Open:

**Azure Portal → Subscriptions → your subscription**

Copy:

```text
Subscription ID
```

For Azure for Students, select the Azure for Students subscription.

---

## 3. Create the Azure client secret

Cloudflare cannot use the GitHub OIDC federated credential directly, so the Worker uses a client secret.

Open:

**Microsoft Entra ID → App registrations → your app → Certificates & secrets → Client secrets → New client secret**

Create a secret and copy the **Value**.

Use that value as:

```text
AZURE_CLIENT_SECRET
```

Important:

- Copy the **Value**, not the Secret ID.
- Azure normally shows the secret value only once.
- Never commit the value to GitHub.

The existing GitHub federated credential can remain in the app. It does not need to be deleted.

---

## 4. Azure permissions

For VM control, give the Entra app access to the VM resource group.

Open:

**Resource group → harmes-vm_group → Access control (IAM) → Add role assignment**

Assign:

```text
Contributor
```

to the Entra application/service principal.

For Azure cost queries, the same identity may also need:

```text
Cost Management Reader
```

at a suitable scope.

---

# Cloudflare setup

## 5. GitHub and Cloudflare Worker deployment

Repository: [SaurovKumer/harmes-vm-automation](https://github.com/SaurovKumer/harmes-vm-automation). The task-aware work is on `feature/hermes-smart-task-design`.

This rollout uses Wrangler to deploy directly to Worker `harmes-vm-automation`. Pushing the feature branch alone is **not** evidence that Cloudflare automatically deployed it. If you configure Cloudflare Git integration, check the branch mapping separately.

```powershell
npx.cmd wrangler deploy --dry-run --config wrangler.toml
# The command below is a REAL deployment of the OFF-by-default config:
npx.cmd wrangler deploy --config wrangler.toml
```

**Do not run the second command to update smart-enabled production unintentionally:** it uses `SMART_DEALLOCATE_ENABLED = "false"` from the file.

Production Worker URL:

```text
https://harmes-vm-automation.saurovkumar07.workers.dev
```

Opening `/` should return JSON containing `"ok": true` and the Telegram webhook path `/telegram`. That is a basic HTTP check only; use `/status` for live smart-mode status.

## 6. Cloudflare variables and secrets

Open:

**Cloudflare → Workers & Pages → your Worker → Settings → Variables and Secrets**

Add the following.

| Name | Type | Where to get it |
| --- | --- | --- |
| `AZURE_CLIENT_ID` | Text or Secret | Entra app → Overview → Application (client) ID |
| `AZURE_TENANT_ID` | Text or Secret | Entra app → Overview → Directory (tenant) ID |
| `AZURE_CLIENT_SECRET` | **Secret** | Entra app → Certificates & secrets → Client secret **Value** |
| `AZURE_SUBSCRIPTION_ID` | Text or Secret | Azure Portal → Subscriptions → Subscription ID |
| `TELEGRAM_BOT_TOKEN` | **Secret** | Telegram BotFather |
| `TELEGRAM_CHAT_ID` | Text or Secret | Telegram Bot API `getUpdates` before webhook setup |
| `TELEGRAM_WEBHOOK_SECRET` | **Secret** | Create it yourself for Telegram webhook authentication |
| `HERMES_EVENT_SECRET` | **Secret** | Automatically generated by `scripts/setup-production.ps1`; authenticates Hermes task events |
| `AZURE_CREDIT_START_DATE` | Text | Date your Azure for Students credit started, format `YYYY-MM-DD` |
| `AZURE_INITIAL_CREDIT` | Text, optional | Initial student credit, default is `100` |

The resource group and VM name are currently already defined in `wrangler.toml`:

```text
RESOURCE_GROUP=harmes-vm_group
VM_NAME=harmes-vm
```

### Example credit settings

```text
AZURE_CREDIT_START_DATE=2026-09-25
AZURE_INITIAL_CREDIT=100
```

Do not put real secrets in the repository.

---

## 7. Create the Telegram bot

Open Telegram and message:

```text
@BotFather
```

Create a bot and copy the bot token.

Save it as:

```text
TELEGRAM_BOT_TOKEN
```

If a bot token is ever exposed, revoke/regenerate it in BotFather.

---

## 8. Find the Telegram Chat ID

Before setting the webhook, send a message such as:

```text
/start
```

to your Telegram bot.

In Windows PowerShell:

```powershell
$botToken = Read-Host "Telegram Bot Token"

$r = Invoke-RestMethod "https://api.telegram.org/bot$botToken/getUpdates"

$r.result[-1].message.chat.id
```

The returned number is:

```text
TELEGRAM_CHAT_ID
```

If a webhook is already active, `getUpdates` may not return updates. In that case, temporarily remove the webhook or use the already-known chat ID.

---

## 9. Create the Telegram webhook secret

`TELEGRAM_WEBHOOK_SECRET` is not provided by Telegram or BotFather.

Create it yourself.

Use only letters, numbers, underscore, and hyphen.

Example format:

```text
vmhermes_2026_secure_A7k9Q2m8
```

Use your own value.

Save exactly the same value in Cloudflare as:

```text
TELEGRAM_WEBHOOK_SECRET
```

Do not share the real secret publicly.

---

# Windows PowerShell terminal setup

The Worker does not need your PC terminal to stay active. Once Cloudflare deploys it, the Worker runs in Cloudflare.

PowerShell is mainly used to:

- configure the Telegram webhook
- verify the webhook
- test the bot
- inspect Telegram errors

## 10. Set temporary terminal variables

Open Windows PowerShell.

Run:

```powershell
$botToken = Read-Host "Telegram Bot Token"
$workerUrl = "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev"
$webhookSecret = Read-Host "TELEGRAM_WEBHOOK_SECRET"
```

Do not include a trailing slash in `$workerUrl`.

Correct:

```text
https://harmes-vm-automation.example.workers.dev
```

Avoid:

```text
https://harmes-vm-automation.example.workers.dev/
```

because adding `/telegram` later could accidentally create `//telegram`.

---

## 11. Register the Telegram webhook

In PowerShell:

```powershell
$webhookUrl = "$workerUrl/telegram"

$body = @{
    url = $webhookUrl
    secret_token = $webhookSecret
    allowed_updates = @("message","callback_query")
} | ConvertTo-Json -Depth 3

Invoke-RestMethod `
  -Method Post `
  -Uri "https://api.telegram.org/bot$botToken/setWebhook" `
  -ContentType "application/json" `
  -Body $body
```

Expected result:

```text
ok     : True
result : True
```

The final webhook URL must look like:

```text
https://YOUR-WORKER.workers.dev/telegram
```

There must be only one slash before `telegram`.

---

## 12. Verify the webhook

Run:

```powershell
$info = Invoke-RestMethod "https://api.telegram.org/bot$botToken/getWebhookInfo"

$info.result | Format-List *
```

Healthy output normally contains:

```text
url                  : https://YOUR-WORKER.workers.dev/telegram
pending_update_count : 0
allowed_updates      : {message, callback_query}
```

If you see:

```text
Wrong response from the webhook: 401 Unauthorized
```

then the Telegram `secret_token` and Cloudflare `TELEGRAM_WEBHOOK_SECRET` do not match.

Set the webhook again using the exact same secret stored in Cloudflare.

---

## 13. Test the bot token

```powershell
Invoke-RestMethod "https://api.telegram.org/bot$botToken/getMe"
```

Expected:

```text
ok : True
```

---

## 14. Test Telegram sending directly

This test checks the bot token and chat ID independently of the Worker.

```powershell
$chatId = Read-Host "Telegram Chat ID"

Invoke-RestMethod `
  -Method Post `
  -Uri "https://api.telegram.org/bot$botToken/sendMessage" `
  -ContentType "application/json" `
  -Body (@{
      chat_id = $chatId
      text = "VM_Hermes direct Telegram test"
  } | ConvertTo-Json)
```

If the test message arrives in Telegram, the bot token and chat ID are valid.

---

## 15. Cloudflare real-time logs

For debugging:

**Cloudflare → Workers & Pages → your Worker → Logs / Observability → Live**

Keep the live log open and send:

```text
/status
```

to the bot.

A healthy webhook request should show something like:

```text
POST /telegram
status: 200
```

If the webhook shows `200` but no Telegram reply appears, check:

- `TELEGRAM_CHAT_ID`
- `TELEGRAM_BOT_TOKEN`
- Azure variables
- Worker exception logs

You can also use Wrangler locally:

```powershell
npx wrangler tail
```

---

# Estimated Azure for Students balance

## How `/balance` works

The Azure for Students Benefits page may show an exact remaining credit, but that exact sponsorship balance is not always exposed to the service principal through the public Azure APIs used by this Worker.

Therefore this project estimates the balance using:

```text
Estimated remaining balance
=
Initial student credit
-
Azure Cost Management usage since the credit start date
```

Example:

```text
Initial credit: 100.00 USD
Estimated used: 8.09 USD
Estimated remaining: 91.91 USD
```

Required variable:

```text
AZURE_CREDIT_START_DATE=YYYY-MM-DD
```

Optional variable:

```text
AZURE_INITIAL_CREDIT=100
```

If `AZURE_INITIAL_CREDIT` is not set, the Worker uses `100`.

The Worker first tries to query cost for the entire Azure subscription. If subscription-wide cost is unavailable, it falls back to the configured resource group and clearly warns that the estimate may exclude costs from other resources.

Azure Cost Management does not accept a custom query period longer than one year in a single request. The Worker automatically splits longer credit periods into smaller chunks.

The estimate may differ slightly from the Azure Portal because Azure cost data can arrive with a delay.

---

# Cost commands

The following commands use Azure Cost Management:

```text
/cost1d
/cost2d
/cost3d
/cost7d
/cost30d
```

Azure cost information is not real-time and can be delayed.

The Worker includes retry handling for temporary Azure throttling such as HTTP `429 Too Many Requests`.

---

# Safety timer: legacy vs. Hermes smart mode

**Legacy (smart OFF or task tracker not initialized):** Every detected VM start receives a **30-minute** safety deadline. About **5 minutes** before expiry Telegram offers extensions (+30m, +1h, +2h, +3h, +4h). Without an extension the Worker requests Azure **deallocation**. Legacy mode does **not** protect a long-running Hermes task.

**Smart (explicitly ON and tracking signed Hermes events):** `POST /hermes-event` accepts authenticated `agent:start`, `agent:step`, `agent:heartbeat` and `agent:end` events. While a tracked task is active, the task-aware idle policy waits. When the last tracked task ends, the system waits **30 minutes of inactivity**, asks via Telegram whether to keep the VM running, and allows **5 minutes to respond**. The confirmation buttons are **Keep Alive +15m**, Status and Deallocate now. No response requests Azure **deallocate** (not just OS shutdown). The system treats a session with no new activity/heartbeat for **45 minutes** as stale and triggers an early confirmation rather than waiting indefinitely.

**Important limitations:** The Gateway must actually deliver events, and no solution can guarantee freedom from a race when Azure receives a deallocation request at the same time a new task begins. Manual `/deallocate` and `/shutdown` still request deallocation; use them only when safe. If signed events have not initialized the tracker, the Worker falls back to the legacy deadline even if the flag is ON.

# Daily auto-start

Set a time:

```text
/autostart 06:00
```

or:

```text
/autostart 19:30
```

The time is interpreted in Bangladesh time.

Disable:

```text
/autostart off
```

The Cloudflare cron trigger checks the schedule every minute.

---

# Deployment, live verification and variable preservation

The Worker is deployed with Wrangler in this rollout. `keep_vars = true` preserves dashboard-managed secrets/variables, but does not override the `SMART_DEALLOCATE_ENABLED` value explicitly defined in the deploy TOML. The cron runs every minute. The Telegram webhook normally does not need to be registered again after a deployment if its URL/secret are unchanged.

```powershell
Invoke-RestMethod "https://harmes-vm-automation.saurovkumar07.workers.dev/"
npx.cmd wrangler deployments list --name harmes-vm-automation --config wrangler.toml
```

Check Telegram `/status` for VM state, **live** Smart Enabled/Disabled, tracked active tasks and inactivity/reply deadlines; also try `/autostart`, `/cost7d` and `/balance` as needed. For diagnostics, inspect Cloudflare Live logs and `systemctl --user status hermes-gateway.service` on the VM. Never copy the live Hermes signing secret into a README, a chat or a Git commit.

# Security notes

- Never commit Telegram bot tokens
- Never commit Azure client secrets
- Never paste real secrets into README files
- Store sensitive values in Cloudflare **Secret** variables
- If the Telegram token is exposed, revoke it immediately in BotFather
- If the Azure client secret is exposed, delete it and create a new one
- Keep Azure permissions limited to the minimum required scope
- Do not confuse Azure Client Secret **Value** with Secret ID

---

# Legacy GitHub Actions

The legacy GitHub Actions workflow files have been removed from the active branch.

The current intended runtime is:

```text
Cloudflare Worker + Telegram webhook + Azure API
```

The active runtime is Cloudflare Worker + Telegram webhook + Azure API, with an optional Hermes task-monitor bridge. GitHub holds source and deployment scripts.

---

# Quick verification checklist

After deployment:

1. Open the Worker URL and confirm `"ok": true` (HTTP health only).
2. Run `getWebhookInfo` and confirm there is no webhook error.
3. Send `/status`, confirm `ENABLED` or `DISABLED (legacy timer)`, and check active task count if connected.
4. Send `/cost7d`.
5. Send `/balance`.
6. Check Cloudflare live logs and Hermes Gateway logs if a command/event does not work.

If `/status` works, the Telegram webhook and basic Azure connection are functioning; task-aware safety still depends on live signed Hermes event delivery.
