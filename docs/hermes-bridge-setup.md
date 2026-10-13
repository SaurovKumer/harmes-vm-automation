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
