// Durable Object: serializes task events, inactivity state and shutdown claims.
// All routes are internal to the bound Cloudflare Worker.
const IDLE_SECONDS = 30 * 60;
const CONFIRM_SECONDS = 5 * 60;
const STALE_SECONDS = 45 * 60; // Lost gateway/heartbeats: ask owner rather than run forever.

function initial() {
  return {
    sessions: {},
    lastEventAt: 0,
    lastCompleteAt: 0,
    receivedCount: 0,
    recentDeliveries: [],
    idleUntil: 0,
    pendingToken: "",
    pendingUntil: 0,
    promptDelivered: false,
    nextPrompt: 0,
    deallocating: false,
    generation: 0,
    staleWarning: false
  };
}
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function snapshot(s, now) {
  const sessions = Object.entries(s.sessions || {});
  return {
    configured: true,
    managed: !!s.lastEventAt,
    activeCount: sessions.length,
    active: sessions.map(([id, v]) => ({
      session: id.slice(0, 10) + "...",
      secondsSinceHeartbeat: Math.max(0, now - v.lastSeen)
    })),
    lastEventAt: s.lastEventAt,
    lastCompleteAt: s.lastCompleteAt,
    receivedCount: s.receivedCount,
    idleUntil: s.idleUntil,
    pendingUntil: s.pendingUntil,
    promptDelivered: !!s.promptDelivered,
    deallocating: !!s.deallocating
  };
}
function cancelPrompt(s) {
  s.pendingToken = "";
  s.pendingUntil = 0;
  s.promptDelivered = false;
  s.nextPrompt = 0;
  s.deallocating = false;
}
function newIdle(s, now, seconds=IDLE_SECONDS) {
  s.idleUntil = now + seconds;
  cancelPrompt(s);
}
function processEvent(s, input, now) {
  const seen = s.recentDeliveries || [];
  if (seen.includes(input.delivery_id)) return { duplicate: true };
  s.recentDeliveries = [...seen.slice(-127), input.delivery_id];
  s.sessions ||= {};
  if (input.event === "agent:start") {
    s.sessions[input.session_id] = { startedAt: now, lastSeen: now };
    s.idleUntil = 0;
    cancelPrompt(s);
  } else if (input.event === "agent:step" || input.event === "agent:heartbeat") {
    // Never resurrect a previously completed or unknown session.
    if (s.sessions[input.session_id]) s.sessions[input.session_id].lastSeen = now;
  } else {
    const existed = !!s.sessions[input.session_id];
    delete s.sessions[input.session_id];
    if (existed && Object.keys(s.sessions).length === 0) newIdle(s, now);
    s.lastCompleteAt = now;
  }
  s.lastEventAt = now;
  s.receivedCount = number(s.receivedCount) + 1;
  s.generation = number(s.generation) + 1;
  return { ok: true, activeCount: Object.keys(s.sessions).length };
}
function clockDecision(s, now) {
  if (!s.lastEventAt) return { action: "legacy" };
  if (s.deallocating) return { action: "deallocating" };
  const entries = Object.entries(s.sessions || {});
  const stale = entries.filter(([id,v]) => now - v.lastSeen > STALE_SECONDS);
  for (const [id] of stale) delete s.sessions[id];
  if (stale.length) {
    s.staleWarning = true;
    // The gateway could have crashed. Notify promptly rather than waiting another 30m.
    if (!Object.keys(s.sessions).length) s.idleUntil = now;
  }
  if (Object.keys(s.sessions).length) return { action: "active" };
  if (!s.idleUntil) s.idleUntil = now + IDLE_SECONDS;

  if (!s.pendingToken && now >= s.idleUntil) {
    s.pendingToken = String(++s.generation);
    s.pendingUntil = 0;
    s.promptDelivered = false;
    s.nextPrompt = now;
  }
  if (!s.pendingToken) return { action: "idle", idleUntil: s.idleUntil };
  if (!s.promptDelivered) {
    return { action: "prompt", token: s.pendingToken, stale: !!s.staleWarning };
  }
  if (now < s.pendingUntil) {
    return { action: "awaiting", pendingUntil: s.pendingUntil };
  }
  return { action: "due", token: s.pendingToken };
}
export class HermesTaskState {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const now = Math.floor(Date.now() / 1000);
    const s = Object.assign(initial(), (await this.state.storage.get("snapshot")) || {});
    if (path === "/status" && request.method === "GET") {
      return Response.json(snapshot(s, now));
    }
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    let input;
    try { input = await request.json(); }
    catch { return Response.json({ error: "Bad JSON" }, { status: 400 }); }
    let answer;
    if (path === "/event") {
      if (!["agent:start", "agent:step", "agent:heartbeat", "agent:end"].includes(input.event)
        || typeof input.session_id !== "string"
        || !input.session_id || input.session_id.length > 256
        || typeof input.delivery_id !== "string"
        || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.delivery_id)) {
        return Response.json({ error: "Invalid event" }, { status: 400 });
      }
      answer = processEvent(s, input, now);
    } else if (path === "/tick") {
      answer = clockDecision(s, now);
    } else if (path === "/prompt-delivered") {
      if (!s.promptDelivered && s.pendingToken && s.pendingToken === input.token) {
        s.promptDelivered = true;
        s.pendingUntil = now + CONFIRM_SECONDS;
        answer = { ok: true, pendingUntil: s.pendingUntil };
      } else answer = { ok: false };
    } else if (path === "/keep") {
      // Only a still-current, unexpired confirmation may be accepted.
      if (!s.pendingToken || !s.promptDelivered || s.pendingToken !== input.token || now >= s.pendingUntil) {
        answer = { ok: false, reason: "expired" };
      } else if (Object.keys(s.sessions || {}).length || s.deallocating) {
        answer = { ok: false, reason: "busy" };
      } else {
        newIdle(s, now, 15 * 60);
        answer = { ok: true, idleUntil: s.idleUntil };
      }
    } else if (path === "/extend") {
      if (s.lastEventAt && !s.deallocating) {
        const deadline = number(input.deadline);
        if (deadline > now && deadline < now + 24 * 3600) {
          s.idleUntil = Math.max(s.idleUntil || 0, deadline);
          cancelPrompt(s);
        }
      }
      answer = { ok: true, managed: !!s.lastEventAt, idleUntil: s.idleUntil };
    } else if (path === "/manual-stop") {
      // Expired buttons must not stop an unrelated/new Hermes session.
      const valid = !!s.pendingToken && s.pendingToken === input.token
        && s.promptDelivered && !s.deallocating
        && !Object.keys(s.sessions || {}).length
        && now < s.pendingUntil;
      if (valid) {
        s.deallocating = true;
        answer = { ok: true };
      } else answer = { ok: false, reason: "expired_or_busy" };
    } else if (path === "/claim") {
      const due = !!s.pendingToken && s.promptDelivered && now >= s.pendingUntil;
      if (!s.deallocating && !Object.keys(s.sessions || {}).length && due && s.pendingToken === input.token) {
        s.deallocating = true;
        answer = { ok: true, generation: s.generation };
      } else answer = { ok: false };
    } else if (path === "/release") {
      // Failed Azure call can be retried next cron tick.
      if (s.deallocating && s.pendingToken === input.token) s.deallocating = false;
      answer = { ok: true };
    } else if (path === "/reset") {
      // Called ONLY after confirmed VM OFF or a new VM boot; clears stale lifecycle.
      Object.assign(s, initial());
      answer = { ok: true };
    } else {
      return new Response("Not found", { status: 404 });
    }
    await this.state.storage.put("snapshot", s);
    return Response.json(answer);
  }
}
