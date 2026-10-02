# Harmes VM Automation

A GitHub Actions + Telegram automation system for safely operating an Azure Virtual Machine.

This project can automatically start an Azure VM, attach a 30-minute safety timer, warn you before deallocation, let you extend the runtime from Telegram, report VM status, show recent Azure costs, and detect manual VM state changes.

> The included workflow is configured for the VM `harmes-vm` in the resource group `harmes-vm_group`.  
> If you fork or reuse this project, change those values to match your own Azure resources.

## Features

### VM automation

- Custom daily auto-start time from Telegram
- Default auto-start time: **06:00 AM Bangladesh time**
- Every VM start gets a **30-minute safety timer**
- Telegram warning approximately **5 minutes before deallocation**
- Automatic **deallocation** if no extension is selected
- Manual Telegram start with a fresh 30-minute timer
- Manual Telegram deallocation
- Detects Azure Portal / external VM starts
- Detects external deallocation
- Detects a VM that is only **Stopped** and requests **Deallocation**
- Shows the planned deallocation time and remaining runtime
- Background state monitor runs every 5 minutes

### Runtime extension buttons

The warning message provides these buttons:

- +30 minutes
- +1 hour
- +2 hours
- +3 hours
- +4 hours
- Status
- Deallocate now

### Telegram commands

| Command | Description |
| --- | --- |
| `/status` | Show VM state, planned deallocation time, remaining runtime, and daily auto-start time |
| `/startvm` | Start the VM and attach a 30-minute safety timer |
| `/deallocate` | Deallocate the VM immediately |
| `/shutdown` | Alias for `/deallocate` |
| `/keep30` | Extend runtime by 30 minutes |
| `/keep60` | Extend runtime by 1 hour |
| `/keep120` | Extend runtime by 2 hours |
| `/keep180` | Extend runtime by 3 hours |
| `/keep240` | Extend runtime by 4 hours |
| `/autostart HH:MM` | Set the daily auto-start time using 24-hour Bangladesh time |
| `/autostart` | Show the current auto-start setting |
| `/autostart off` | Disable daily auto-start |
| `/cost1d` | Show latest available cost for the last 1 day |
| `/cost2d` | Show latest available cost for the last 2 days |
| `/cost3d` | Show latest available cost for the last 3 days |
| `/cost7d` | Show latest available cost for the last 7 days |
| `/cost30d` | Show latest available cost for the last 30 days |
| `/balance` | Try to show the remaining Azure credit balance |
| `/help` | Show available commands |

Example:

```text
/autostart 07:30
```

This sets the daily auto-start time to 07:30 AM Bangladesh time.

## Status meanings

The bot clearly separates Azure VM power states:

- **RUNNING** — the VM is running.
- **STOPPED (NOT DEALLOCATED)** — the guest VM is stopped, but compute allocation may still exist.
- **DEALLOCATED** — the compute allocation has been released.

The automation uses Azure **deallocation**, not a normal guest shutdown, when its timer expires.

## How it works

The project contains two main workflows:

```text
.github/workflows/vm-schedule.yml
.github/workflows/telegram-control.yml
```

### `telegram-control.yml`

Runs on a 5-minute GitHub Actions schedule and handles:

- Telegram commands
- Daily auto-start
- Manual Azure state-change detection
- Runtime deadline checks
- Cost and balance queries
- Safety deallocation
- Telegram command menu updates

### `vm-schedule.yml`

Provides the VM lifecycle guard for a manually triggered GitHub Actions start. It starts the VM, creates the 30-minute deadline, sends notifications, and watches the final warning period.

## Setup guide

### 1. Requirements

You need:

- An Azure subscription
- An Azure VM
- A GitHub account
- A GitHub repository containing these workflows
- A Telegram account
- A Telegram bot created with BotFather

Azure for Students can also be used.

### 2. Fork or copy the repository

Copy this project into your own GitHub repository.

The workflows expect the default branch to be:

```text
main
```

### 3. Set your VM and resource group

Open both workflow files and update:

```yaml
env:
  RESOURCE_GROUP: your-resource-group
  VM_NAME: your-vm-name
```

In this repository they are currently:

```yaml
RESOURCE_GROUP: harmes-vm_group
VM_NAME: harmes-vm
```

### 4. Create a Microsoft Entra application

In the Azure portal:

1. Open **Microsoft Entra ID**
2. Open **App registrations**
3. Select **New registration**
4. Create an application for this GitHub automation
5. Copy:
   - Application (client) ID
   - Directory (tenant) ID
6. Copy your Azure Subscription ID as well

You do **not** need to create and store a client secret when using GitHub OIDC.

### 5. Add a GitHub federated credential

In the Entra application:

1. Open **Certificates & secrets**
2. Open **Federated credentials**
3. Add a credential for **GitHub Actions**
4. Select your GitHub organization/user
5. Select your repository
6. Choose **Branch**
7. Set the branch to `main`

The subject should correspond to your own repository and branch.

### 6. Give the Entra application Azure access

Open the Azure resource group that contains your VM:

**Resource group → Access control (IAM) → Add role assignment**

Assign the Entra application:

```text
Contributor
```

at the resource-group scope.

This allows the workflow to start, inspect, tag, stop, and deallocate the VM.

For the cost commands, you may also need:

```text
Cost Management Reader
```

The `/balance` command can require additional billing-level read access depending on the Azure subscription and billing-account type.

### 7. Add GitHub repository secrets

Go to:

**GitHub repository → Settings → Secrets and variables → Actions**

Add these repository secrets:

```text
AZURE_CLIENT_ID
AZURE_TENANT_ID
AZURE_SUBSCRIPTION_ID
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

Never commit the real Telegram bot token, Azure credentials, or other secrets into the repository.

### 8. Create the Telegram bot

In Telegram:

1. Open **@BotFather**
2. Create a new bot
3. Copy the generated bot token
4. Open your new bot
5. Send `/start`
6. Save the bot token as the GitHub secret `TELEGRAM_BOT_TOKEN`

If a Telegram bot token is accidentally shared publicly, revoke it through BotFather and generate a new one.

### 9. Find your Telegram Chat ID

After sending `/start` to the bot, you can retrieve the latest update using the Telegram Bot API.

One simple PowerShell method is:

```powershell
$env:BOT_TOKEN="YOUR_NEW_BOT_TOKEN"

$r = Invoke-RestMethod "https://api.telegram.org/bot$env:BOT_TOKEN/getUpdates"

$r.result[-1].message.chat.id
```

Save the returned number as:

```text
TELEGRAM_CHAT_ID
```

in GitHub Actions secrets.

Do not place the bot token in the repository.

### 10. Test Azure authentication

Open:

**GitHub → Actions**

Run one of the workflows manually.

A successful Azure login confirms that the OIDC configuration, repository secrets, and Azure role assignment are working.

### 11. Test Telegram control

Run:

```text
Telegram VM Status & Safety Monitor
```

manually once from GitHub Actions.

Then send:

```text
/status
```

to the Telegram bot.

You should receive the current VM state.

### 12. Configure daily auto-start

For example:

```text
/autostart 06:00
```

or:

```text
/autostart 19:30
```

The time is interpreted in the **Asia/Dhaka / Bangladesh** timezone.

To disable it:

```text
/autostart off
```

## Example lifecycle

```text
07:30  Daily auto-start triggers
  ↓
VM becomes RUNNING
  ↓
30-minute safety deadline is created
  ↓
07:55  Telegram warning
  ↓
Choose +30m / +1h / +2h / +3h / +4h
or do nothing
  ↓
08:00  No extension → VM is DEALLOCATED
```

If the VM is started manually from Azure Portal, the monitor detects it and attaches a new 30-minute safety timer.

## Cost commands

The cost commands query Azure Cost Management for the resource group used by this project.

Available commands:

```text
/cost1d
/cost2d
/cost3d
/cost7d
/cost30d
```

Azure Cost Management data is **not real-time**. Recent usage can take time to appear.

If a cost command returns a permission error, assign **Cost Management Reader** to the GitHub Entra application at an appropriate scope.

## Azure credit balance

The command:

```text
/balance
```

tries to read the Azure billing credit balance using Azure APIs and the existing OIDC identity.

No separate third-party API key is required.

However, exact credit-balance access depends on the Azure billing model and the permissions available to the Entra application. Some Azure for Students or sponsorship accounts may not expose the balance to this service principal even when normal VM and cost operations work.

## Important timing notes

GitHub Actions scheduled workflows have a minimum practical cron interval of 5 minutes for this project.

Because of that:

- Manual Azure ON/OFF detection may take a few minutes
- A custom daily auto-start can occur a few minutes after the selected time
- Long-extension expiry checks can also be delayed slightly

The final warning workflow polls more frequently while it is actively running, but GitHub Actions should not be treated as a real-time control system.

## Security notes

- Never commit Azure credentials or Telegram tokens
- Use GitHub Actions secrets
- Prefer GitHub OIDC instead of long-lived Azure client secrets
- Scope Azure permissions to the smallest resource group that needs automation
- Revoke a Telegram bot token immediately if it is exposed
- Keep the repository private if it contains environment-specific infrastructure details

## Notes

This project was created for lightweight personal Azure VM automation. Test the workflows with a non-critical VM before depending on them for important workloads.
