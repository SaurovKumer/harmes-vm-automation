# Harmes VM Automation

Cloudflare Worker + Telegram automation for safely operating an Azure Virtual Machine.

The current runtime is **Cloudflare-based**. GitHub is used mainly for source control and automatic deployment to Cloudflare. Telegram sends commands to the Worker through a webhook, and the Worker talks directly to Azure.

> Current default VM:
>
> - Resource group: `harmes-vm_group`
> - VM name: `harmes-vm`
> - Time zone used by the bot: Bangladesh / Asia-Dhaka

---

## Features

- Start the Azure VM from Telegram
- Deallocate the VM from Telegram
- 30-minute safety runtime after a VM start
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
Telegram
   |
   | HTTPS webhook
   v
Cloudflare Worker
   |
   +--> Azure Resource Manager
   |      - VM status
   |      - start
   |      - deallocate
   |      - VM/resource-group tags
   |
   +--> Azure Cost Management
   |      - recent costs
   |      - estimated student balance
   |
   +--> Telegram Bot API
          - replies
          - warning buttons

Cloudflare Cron Trigger
   |
   +--> runs every minute
        - daily auto-start check
        - safety deadline check
        - 5-minute warning
        - manual VM state detection
```

GitHub stores the source code. Cloudflare Git integration automatically deploys changes from the `main` branch.

---

## Important files

```text
README.md
src/
└── index.js
wrangler.toml
```

Current `wrangler.toml` contains:

```toml
name = "vm-hermes-controller"
main = "src/index.js"
compatibility_date = "2026-10-01"
workers_dev = true
keep_vars = true

[vars]
RESOURCE_GROUP = "harmes-vm_group"
VM_NAME = "harmes-vm"

[triggers]
crons = ["* * * * *"]
```

`keep_vars = true` is important because it tells Wrangler to preserve variables/secrets that were added in the Cloudflare dashboard when new code is deployed.

---

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

## 5. Connect the GitHub repository

In Cloudflare:

**Workers & Pages → Create / Import repository**

Connect:

```text
SaurovKumer/harmes-vm-automation
```

Recommended deployment settings:

```text
Production branch: main
Root directory: repository root / leave blank
Build command: leave empty
Deploy command: npx wrangler deploy
```

After a successful deploy, Cloudflare gives a Worker URL similar to:

```text
https://harmes-vm-automation.YOUR-SUBDOMAIN.workers.dev
```

Opening the root URL should return health JSON similar to:

```json
{
  "ok": true,
  "service": "VM_Hermes Cloudflare Worker",
  "telegramWebhook": "/telegram",
  "scheduler": "every minute"
}
```

---

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
| `TELEGRAM_WEBHOOK_SECRET` | **Secret** | Create it yourself |
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

# Safety timer

Whenever the automation starts the VM, it creates a 30-minute runtime deadline.

Approximately 5 minutes before that deadline, Telegram sends buttons:

```text
+30 min
+1 hour
+2 hours
+3 hours
+4 hours
Status
Deallocate now
```

If no extension is selected, the Worker requests Azure VM deallocation when the deadline expires.

---

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

# Deployment and variable preservation

GitHub changes are automatically deployed through Cloudflare Git integration.

Because the project uses:

```toml
keep_vars = true
```

Cloudflare dashboard variables/secrets should remain available after future Wrangler deployments.

After changing code, you normally do **not** need to run a terminal command to activate the Worker. Once Cloudflare reports that the deployment succeeded, the new Worker version is live.

You also do not need to call `setWebhook` after every code deployment. The webhook remains configured unless its URL or secret changes.

---

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

The active runtime is Cloudflare Worker + Telegram webhook + Azure API; GitHub is used only for source control and Cloudflare deployment.

---

# Quick verification checklist

After deployment:

1. Open the Worker URL and confirm `"ok": true`.
2. Run `getWebhookInfo` and confirm there is no webhook error.
3. Send `/status`.
4. Send `/cost7d`.
5. Send `/balance`.
6. Check Cloudflare live logs if a command does not reply.

If `/status` works, the Telegram webhook, Cloudflare Worker, and basic Azure connection are functioning.
