// Durable, task-aware event records for the Hermes gateway.
// This stage stores only task lifecycle metadata; it DOES NOT control VM power.
const empty = () => ({
  sessions: {},
  lastEventAt: 0,
  lastCompleteAt: 0,
  recentDeliveries: [],
  receivedCount: 0
});

export class HermesTaskState {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const old = (await this.state.storage.get("snapshot")) || empty();

    if (path === "/status" && request.method === "GET") {
      const now = Math.floor(Date.now() / 1000);
      const sessions = Object.entries(old.sessions || {});
      return Response.json({
        configured: true,
        activeCount: sessions.length,
        active: sessions.map(([id, v]) => ({
          session: id.slice(0, 10) + "...",
          secondsSinceHeartbeat: Math.max(0, now - v.lastSeen)
        })),
        lastEventAt: old.lastEventAt,
        lastCompleteAt: old.lastCompleteAt,
        receivedCount: old.receivedCount
      });
    }

    if (path !== "/event" || request.method !== "POST") {
      return new Response("Not found", {status: 404});
    }

    const input = await request.json();
    if (!["agent:start", "agent:step", "agent:end"].includes(input.event)
      || typeof input.session_id !== "string"
      || !input.session_id
      || input.session_id.length > 256
      || typeof input.delivery_id !== "string"
      || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.delivery_id)) {
      return Response.json({error: "Invalid event"}, {status: 400});
    }

    const now = Math.floor(Date.now() / 1000);
    if ((old.recentDeliveries || []).includes(input.delivery_id)) {
      return Response.json({ok: true, duplicate: true});
    }

    const sessions = old.sessions || {};
    if (input.event === "agent:start") {
      sessions[input.session_id] = {startedAt: now, lastSeen: now};
    } else if (input.event === "agent:step") {
      // A late step is NOT allowed to reopen a completed session.
      if (sessions[input.session_id]) sessions[input.session_id].lastSeen = now;
    } else if (input.event === "agent:end") {
      delete sessions[input.session_id];
      old.lastCompleteAt = now;
    }

    old.sessions = sessions;
    old.lastEventAt = now;
    old.receivedCount = (old.receivedCount || 0) + 1;
    old.recentDeliveries = [...(old.recentDeliveries || []).slice(-127), input.delivery_id];
    await this.state.storage.put("snapshot", old);

    return Response.json({ok: true, activeCount: Object.keys(sessions).length});
  }
}
