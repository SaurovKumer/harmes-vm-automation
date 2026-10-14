# Hermes bridge: staged rollout (not production ready)

Current development branch only stores signed task events. **It does not change the scheduler or enable task-aware shutdown.**

## Prerequisite — check actual Gateway context
The Python bridge uses `context.get("session_id")`. Hermes hook context fields depend on the installed version. Before installation, temporarily log **context keys only** (never payload values, messages, credentials) and verify a stable session identifier exists. If not, adapt the bridge to the field confirmed by the installed Hermes version. Also verify the hook's async handler is called for every event.

## Cloudflare staging
1. Create a separate Cloudflare Worker environment or preview deploy from this feature branch. Do not deploy to the production worker.
2. Set `HERMES_EVENT_SECRET` as a Cloudflare Secret (32+ random bytes encoded as a string). Do not commit it.
3. Check Durable Object SQLite binding/migration deployment. Keep the existing Azure and Telegram credentials out of the staging environment if possible; the event-only receiver does not require them.
4. Set `~/.hermes/vm-task-monitor.json` with mode 0600:
```json
{"worker_url":"https://YOUR-STAGING-WORKER.workers.dev","secret":"YOUR-RANDOM-SECRET"}
```
5. Copy `scripts/hermes_task_hook.py` to `~/.hermes/hooks/vm-task-monitor/handler.py` after verifying Hermes hook context fields. Keep the existing `HOOK.yaml`. Restart the gateway.
6. Test start/step/end events and Cloudflare logs. Do not share secrets or full hook contexts.

## Remaining work before smart shutdown
- Validate lifecycle session IDs and simultaneous tasks.
- Support reliable heartbeat during long silent operations and graceful handling of missed events.
- Add task-state querying to the scheduler, atomic deallocation checks, and a finite stale-task fallback.
- Add inactivity prompt, 5-minute confirmation, and 15-minute keep-alive button; preserve all legacy commands.
- Run automated tests for existing commands, stale events, duplicate delivery, restart and scheduler concurrency.
- Deploy to production **only after** the checks pass.

## Known constraints
Hook requests use a 4-second timeout; if event delivery fails, the Python hook writes only the error type to its local log. There is currently no retry queue. The Durable Object accepts signed events less than five minutes old and deduplicates recent delivery IDs; production needs more robust deduplication for higher event volumes. Task events sent while the VM is shutting down can be lost; do not use absence of an end event as proof that work has finished.


## New task-aware implementation (not yet production tested)

The development branch adds a smart lifecycle state machine in `src/hermes-task-state.js` and integrates it with the production cron logic in `src/index.js`. Original commands remain.

Run locally (Node.js 22 or later):
```powershell
git pull origin feature/hermes-smart-task-design
node --check src/index.js
node --check src/hermes-task-state.js
node --test tests/hermes-task-state.test.mjs
npx.cmd wrangler deploy --config wrangler.staging.toml
```

**Do not merge until the tests pass.** Staging deliberately has no Azure access or scheduler, so testing staging validates only Hermes event ingress and Durable Object behavior, not actual automatic deallocation.

Before production rollout:
1. Provision `HERMES_EVENT_SECRET` on the **production** Cloudflare Worker; use a dedicated secret distinct from staging.
2. The VM hook currently reports to **staging**. After production is deployed and configured, update `~/.hermes/vm-task-monitor.json` with the production worker URL and its new secret. Never reveal the secret in logs/chat.
3. Confirm production receives `agent:start` and `agent:end` via its authenticated status endpoint **before** relying on task-aware deallocation.
4. Verify a >30-minute test task stays running, a 30-minute idle prompts, a 5-minute no-reply deallocates, `Keep Alive` adds 15 minutes, and a new task cancels an old confirmation.
5. Keep the legacy 30-minute fallback for sessions that have never delivered a valid lifecycle event to production.
6. Back up and test the production Worker before merging. The staging test alone does not establish end-to-end safety.

**Known limitation:** Gateway `agent:step` is not a guaranteed heartbeat during an uninterrupted long-running tool call; the coordinator currently considers a session stale after 45 minutes without an event, and may prompt for deallocation. This is a cost safety measure; improve with a gateway-level periodic heartbeat before claiming all long-running tasks are protected. A brief race remains possible between checking task state and Azure accepting a deallocation request; require a production integration test before rollout.


## Explicit Smart Deallocation enable switch

The Worker is now **opt-in**: `SMART_DEALLOCATE_ENABLED` must be the literal string `true` for the task-aware scheduler to supersede the existing Azure tag deadline. With this variable missing or `false`, the existing legacy safety timer **still deallocates the VM even if Hermes is busy**. A code deployment alone DOES NOT enable Smart Deallocation.

Before enabling, verify the production endpoint (not staging) is receiving fresh events. Use `wrangler secret put HERMES_EVENT_SECRET` for the production secret, use a separate production secret from staging, and change the VM's private hook URL/secret only after ensuring the production worker is ready. Do not print secrets. When ready to opt in, set `SMART_DEALLOCATE_ENABLED=true` on the production Worker using the Cloudflare dashboard or appropriate Wrangler variable configuration. The production `/status` Telegram command displays whether smart mode is enabled.

**Do not enable yet**: Azure transition races, stale heartbeat failure, and real Telegram delivery still need end-to-end verification. The dry-run mocks verify that the Worker specifically calls the Azure `/deallocate` endpoint; no VM is deallocated by tests.
