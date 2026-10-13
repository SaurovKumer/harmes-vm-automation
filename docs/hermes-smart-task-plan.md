# Hermes task-aware VM controller — implementation plan

This is a design-only branch. **Do not deploy until the Hermes-to-Worker completion/heartbeat integration is implemented and tested.**

## Existing behavior to preserve
Keep Telegram commands, daily auto-start, cost/balance reporting, Azure power-state detection, and manual deallocation unchanged. Existing 30-minute safety timers remain the fallback for VM sessions without an authenticated Hermes task.

## Proposed state machine
- **IDLE**: no active task. Reset inactivity deadline on authenticated user interaction. After 30 minutes idle, send a Telegram confirmation with `Keep 15 minutes` and `Deallocate now` buttons.
- **AWAITING_CONFIRMATION**: five-minute reply window. A new authorized Hermes task or conversation resumes ACTIVE and cancels the pending shutdown. `Keep 15 minutes` sets the next inactivity deadline 15 minutes ahead. No response: deallocate.
- **ACTIVE**: an authenticated Hermes task is running. Record task ID, started time, last heartbeat and state in durable storage. The 30-minute legacy timer must not deallocate an actively progressing task.
- **TASK_COMPLETE**: Hermes reports success/failure, sends the result to Telegram, and enters IDLE with a fresh 30-minute inactivity deadline.
- **STALE/FAILED**: if heartbeat expires or Hermes becomes unreachable, notify the owner and use a finite fail-safe grace period rather than keeping the VM running indefinitely.

## Required integration
The existing Cloudflare Worker only receives Telegram commands and calls Azure APIs. It **does not currently know** whether Hermes is busy or whether a task is complete. Add an authenticated Hermes-side task runner/bridge that emits task_started, heartbeat, task_completed/task_failed and conversation_activity events. Worker endpoints must validate a dedicated secret and reject replayed events. Do not mistake a Telegram message received by the VM-control bot for a task executed by Hermes.

Use Cloudflare Durable Objects (or another atomic durable store) for task state, deadlines and event deduplication. Azure VM tags can continue to hold the legacy fallback deadline, but avoid using them as the only store for high-frequency heartbeats.

## Race and safety rules
- The scheduler must recheck task state immediately before deallocation.
- Use a lease/lock to avoid duplicate cron actions or overlapping start/deallocate requests.
- Manual `/deallocate` must remain authoritative; cancel tasks gracefully if possible.
- A maximum runtime / stale-heartbeat fail-safe is necessary to avoid unlimited Azure charges.
- Protect against late Telegram button clicks using an expiry token.
- Never expose Telegram tokens, Azure credentials or Hermes API keys in the repository.
- Keep the production `main` branch untouched until tested.

## Acceptance tests
1. A task lasts more than 30 minutes and keeps the VM running while heartbeats are healthy.
2. Task completion starts a 30-minute idle window.
3. At 30 minutes idle, Telegram prompts for confirmation; after 5 minutes without a response, VM deallocates.
4. `Keep 15 minutes` cancels the pending shutdown and extends by 15 minutes.
5. A new task during the confirmation window cancels deallocation.
6. Conversation activity refreshes inactivity without changing the legacy manual extension commands.
7. Stale heartbeats, duplicate webhook events and concurrent cron runs are handled safely.
8. Existing /status, /startvm, /deallocate, /keep*, /autostart, /cost*, and /balance commands pass regression tests.
