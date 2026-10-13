# Hermes Smart Task Manager — development plan

Status: development only. This branch must not be merged/deployed until the Telegram integration and VM runner are verified.

## Existing behavior to preserve
- Telegram VM-control commands, Azure costs, and daily scheduler.
- 30-minute safety timeout for manually started VMs.
- No changes to production Cloudflare worker until reviewed.

## Intended behavior
1. Disable daily start using existing `/autostart off` (user action; not changed automatically).
2. Hermes Telegram messages must be accepted while VM is deallocated. First inspect whether Hermes currently uses Telegram polling or webhook; **never configure a second consumer for the same bot token**.
3. A Cloudflare ingress service verifies Telegram secret/chat, deduplicates update IDs, and stores work in durable storage (D1 or Durable Object).
4. Start VM only for queued work. A VM-side authenticated runner claims jobs with leases, executes Hermes via the *verified* installed CLI/API, sends heartbeat and completion status.
5. During active leased work, scheduled shutdown is postponed. A 30-minute timer must never interrupt a healthy task.
6. When no queued/running work remains, wait five minutes and deallocate. Do not deallocate merely because a single job finished if other jobs are pending.
7. Failure modes: retries with backoff, idempotent job claiming, bounded execution, heartbeat expiry, recovery after VM restart, and emergency runtime ceiling (configurable; proposed 3 hours, **not yet user-approved**).
8. Require explicit user confirmation for destructive operations, production deployment, and merges. Limit API/VM access to least privilege.
9. VM controller and Hermes bot can remain separate. Keep all bot tokens, Azure secrets, and task-auth secrets out of Git.

## First implementation steps
- Confirm Hermes Telegram transport, installation path, start command, and runner invocation on the VM.
- Add D1 schema and a separate task-ingress handler only after choosing the transport.
- Implement a VM runner with claim/heartbeat/complete protocol and startup service.
- Update scheduler to respect task leases and idle grace period; test against a mocked Azure API.
- Deploy to staging Worker with separate test configuration before production merge.

## Acceptance tests
- VM deallocated: new Hermes message is persisted, VM starts, task executes once, reply arrives.
- 60+ minute healthy task is not interrupted at 30 minutes.
- After last task completes, VM deallocates after five idle minutes.
- Stalled task expires and does not run VM indefinitely.
- Duplicate Telegram delivery does not execute twice.
- Existing `/status`, `/startvm`, `/deallocate`, `/balance` remain functional.
