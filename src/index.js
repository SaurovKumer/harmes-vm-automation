export { HermesTaskState } from "./hermes-task-state.js";

let tokenCache = { token: null, expiresAt: 0 };

const ARM = "https://management.azure.com";
const COMPUTE_API = "2025-04-01";
const TAGS_API = "2021-04-01";
const COST_API = "2026-06-01";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({
        ok: true,
        service: "VM_Hermes Cloudflare Worker",
        telegramWebhook: "/telegram",
        scheduler: "every minute"
      });
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || providedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      ctx.waitUntil(handleTelegramUpdate(update, env));
      return new Response("OK");
    }

    if (request.method === "GET" && url.pathname === "/hermes-status") {
      // Read-only staging verification endpoint. Never returns messages or tokens.
      const secret = String(env.HERMES_EVENT_SECRET || "");
      if (secret.length < 32 || !env.HERMES_TASK_STATE) {
        return new Response("Not configured", { status: 503 });
      }
      const supplied = request.headers.get("X-Hermes-Status-Token") || "";
      // Both values are known to be nonempty and lengthy; avoid plain string equality.
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey("raw", enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      // The caller supplies a short-lived, epoch-minute-specific digest.
      const nowMinute = Math.floor(Date.now() / 60000);
      const valid = await Promise.all([nowMinute - 1, nowMinute, nowMinute + 1].map(async minute => {
        const bytes = await crypto.subtle.sign("HMAC", key, enc.encode("status:" + minute));
        return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("") === supplied;
      }));
      if (!valid.some(Boolean)) return new Response("Unauthorized", { status: 401 });
      const id = env.HERMES_TASK_STATE.idFromName("single-vm");
      return env.HERMES_TASK_STATE.get(id).fetch("https://internal/status");
    }

    if (request.method === "POST" && url.pathname === "/hermes-event") {
      // Task lifecycle receiver only. No VM-power action in this version.
      const secret = String(env.HERMES_EVENT_SECRET || "");
      if (secret.length < 32 || !env.HERMES_TASK_STATE) {
        return new Response("Not configured", { status: 503 });
      }
      const raw = await request.text();
      if (raw.length > 4096) return new Response("Too large", { status: 413 });
      const signature = request.headers.get("X-Hermes-Signature-256") || "";
      const key = await crypto.subtle.importKey("raw",
        new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" },
        false, ["verify"]);
      const supplied = signature.startsWith("sha256=") ? signature.slice(7) : "";
      if (!/^[0-9a-f]{64}$/i.test(supplied)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const bytes = new Uint8Array(supplied.match(/../g).map(x => parseInt(x, 16)));
      const authenticated = await crypto.subtle.verify("HMAC", key, bytes,
        new TextEncoder().encode(raw));
      if (!authenticated) return new Response("Unauthorized", { status: 401 });
      let payload;
      try { payload = JSON.parse(raw); }
      catch { return new Response("Bad JSON", { status: 400 }); }
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isInteger(payload.timestamp) || Math.abs(now - payload.timestamp) > 300) {
        return new Response("Stale event", { status: 400 });
      }
      const objectId = env.HERMES_TASK_STATE.idFromName("single-vm");
      return env.HERMES_TASK_STATE.get(objectId).fetch(
        new Request("https://internal/event", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
      );
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduler(env));
  }
};


async function taskRpc(env, path, payload) {
  if (!env.HERMES_TASK_STATE) return null;
  const id = env.HERMES_TASK_STATE.idFromName("single-vm");
  const req = path === "/status"
    ? new Request("https://internal/status")
    : new Request("https://internal" + path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
      });
  const res = await env.HERMES_TASK_STATE.get(id).fetch(req);
  if (!res.ok) throw new Error("Hermes state " + path + ": HTTP " + res.status);
  return res.json();
}
async function handleSmartScheduler(env) {
  const tick = await taskRpc(env, "/tick");
  if (!tick || tick.action === "legacy") return false;
  if (tick.action === "prompt") {
    await sendMessage(env,
      (tick.stale ? "⚠️ Hermes heartbeat is stale.\\n" : "") +
      "🤖 Hermes is inactive. Keep VM running?\\n" +
      "No reply within 5 minutes = Azure DEALLOCATION.",
      [[{ text: "✅ Keep Alive +15m", callback_data: "smartkeep15|" + tick.token }],
       [{ text: "📊 Status", callback_data: "status|0" },
        { text: "🛑 Deallocate now", callback_data: "smartstop|" + tick.token }]]
    );
    await taskRpc(env, "/prompt-delivered", { token: tick.token });
  } else if (tick.action === "due") {
    const claim = await taskRpc(env, "/claim", { token: tick.token });
    if (claim?.ok) {
      try {
        const latest = await taskRpc(env, "/status");
        if (latest?.deallocating && latest.activeCount === 0) {
          await deallocateVm(env);
          await mergeTags(env, {
            RunUntilEpoch: 0, RunUntilLocal: "none",
            WarningForEpoch: 0, LastPowerState: "deallocating"
          });
          await sendMessage(env, "🛑 Hermes idle window expired: VM DEALLOCATION requested.");
        } else await taskRpc(env, "/release", { token: tick.token });
      } catch (err) {
        await taskRpc(env, "/release", { token: tick.token });
        throw err;
      }
    }
  }
  return true;
}

async function getAzureToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    client_id: env.AZURE_CLIENT_ID,
    client_secret: env.AZURE_CLIENT_SECRET,
    scope: "https://management.azure.com/.default",
    grant_type: "client_credentials"
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(env.AZURE_TENANT_ID)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    }
  );

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Azure login failed: ${safeText(data)}`);
  }

  const expiresIn = Number(data.expires_in || 3600);
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, expiresIn - 120) * 1000
  };

  return tokenCache.token;
}

function vmResourceId(env) {
  return `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${env.RESOURCE_GROUP}/providers/Microsoft.Compute/virtualMachines/${env.VM_NAME}`;
}

async function azureRequest(env, method, pathOrUrl, body) {
  const token = await getAzureToken(env);
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${ARM}${pathOrUrl}`;

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok && res.status !== 202) {
    throw new Error(`Azure ${method} ${res.status}: ${safeText(data)}`);
  }

  return { status: res.status, data, headers: res.headers };
}

async function getTags(env) {
  const scope = vmResourceId(env);
  const { data } = await azureRequest(
    env,
    "GET",
    `${scope}/providers/Microsoft.Resources/tags/default?api-version=${TAGS_API}`
  );
  return data?.properties?.tags || {};
}

async function mergeTags(env, values) {
  const scope = vmResourceId(env);
  const tags = {};
  for (const [k, v] of Object.entries(values)) {
    tags[k] = String(v);
  }

  await azureRequest(
    env,
    "PATCH",
    `${scope}/providers/Microsoft.Resources/tags/default?api-version=${TAGS_API}`,
    {
      operation: "Merge",
      properties: { tags }
    }
  );
}

async function getPowerState(env) {
  const { data } = await azureRequest(
    env,
    "GET",
    `${vmResourceId(env)}/instanceView?api-version=${COMPUTE_API}`
  );

  const status = (data?.statuses || []).find((s) =>
    String(s?.code || "").startsWith("PowerState/")
  );

  const code = String(status?.code || "").replace("PowerState/", "").toLowerCase();
  const display = String(status?.displayStatus || "Unknown");

  return { code, display };
}

async function startVm(env) {
  await azureRequest(
    env,
    "POST",
    `${vmResourceId(env)}/start?api-version=${COMPUTE_API}`
  );
}

async function deallocateVm(env) {
  await azureRequest(
    env,
    "POST",
    `${vmResourceId(env)}/deallocate?api-version=${COMPUTE_API}`
  );
}

async function telegram(env, method, payload = {}) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram ${method} failed: ${safeText(data)}`);
  }

  return data;
}

async function sendMessage(env, text, inlineKeyboard = null) {
  const payload = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text
  };

  if (inlineKeyboard) {
    payload.reply_markup = { inline_keyboard: inlineKeyboard };
  }

  return telegram(env, "sendMessage", payload);
}

async function answerCallback(env, callbackId, text) {
  try {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text
    });
  } catch (err) {
    console.log("answerCallback error", String(err));
  }
}

function warningKeyboard(deadline) {
  const d = String(deadline);
  return [
    [
      { text: "⏱ +30 min", callback_data: `keep30|${d}` },
      { text: "⏱ +1 hour", callback_data: `keep60|${d}` }
    ],
    [
      { text: "⏱ +2 hours", callback_data: `keep120|${d}` },
      { text: "⏱ +3 hours", callback_data: `keep180|${d}` }
    ],
    [
      { text: "⏱ +4 hours", callback_data: `keep240|${d}` }
    ],
    [
      { text: "📊 Status", callback_data: `status|${d}` },
      { text: "🛑 Deallocate now", callback_data: `deallocate|${d}` }
    ]
  ];
}

async function sendWarning(env, deadline) {
  await mergeTags(env, { WarningForEpoch: deadline });
  await sendMessage(
    env,
    `⚠️ ${env.VM_NAME} will be DEALLOCATED in about 5 minutes.\n` +
      `Scheduled: ${formatDhakaEpoch(deadline)}\n\n` +
      "No response = automatic DEALLOCATION.",
    warningKeyboard(deadline)
  );
}

async function statusMessage(env) {
  const [state, tags] = await Promise.all([
    getPowerState(env),
    getTags(env)
  ]);

  const now = epochNow();
  const deadline = intTag(tags.RunUntilEpoch);
  const auto = autoStartText(tags);
  const lines = [
    `🖥 ${env.VM_NAME}`,
    `Status: ${stateLabel(state.code, state.display)}`
  ];

  if (deadline > now) {
    lines.push(`⏳ Planned deallocation: ${formatDhakaEpoch(deadline)}`);
    lines.push(`⌛ Remaining: ${remainingText(deadline)}`);
  } else {
    lines.push("⏳ Planned deallocation: not currently set");
  }

  if (env.HERMES_TASK_STATE) {
    const task = await taskRpc(env, "/status");
    if (task?.managed) {
      lines.push(`🤖 Hermes active tasks: ${task.activeCount}`);
      if (task.pendingUntil > now) lines.push(`⏰ Reply by: ${formatDhakaEpoch(task.pendingUntil)}`);
      else if (!task.activeCount && task.idleUntil > now)
        lines.push(`💤 Inactivity deadline: ${formatDhakaEpoch(task.idleUntil)}`);
    }
  }
  lines.push(`⏰ Daily auto-start: ${auto} (Bangladesh time)`);
  return lines.join("\n");
}

async function requestStart(env, source = "Telegram") {
  const state = await getPowerState(env);
  const now = epochNow();

  if (state.code === "running") {
    const tags = await getTags(env);
    const deadline = intTag(tags.RunUntilEpoch);

    if (deadline > now) {
      return (
        `🟢 ${env.VM_NAME} is already RUNNING.\n` +
        `Planned deallocation: ${formatDhakaEpoch(deadline)}`
      );
    }

    const newDeadline = now + 30 * 60;
    await mergeTags(env, {
      RunUntilEpoch: newDeadline,
      RunUntilLocal: formatTagTime(newDeadline),
      WarningForEpoch: 0,
      LastPowerState: "running"
    });

    return (
      `🟢 ${env.VM_NAME} is already RUNNING.\n` +
      "A fresh 30-minute safety timer was attached.\n" +
      `Planned deallocation: ${formatDhakaEpoch(newDeadline)}`
    );
  }

  await startVm(env);
  await taskRpc(env, "/reset");
  const deadline = now + 30 * 60;

  await mergeTags(env, {
    RunUntilEpoch: deadline,
    RunUntilLocal: formatTagTime(deadline),
    WarningForEpoch: 0,
    LastPowerState: "starting"
  });

  return (
    `🟡 ${source} START request accepted for ${env.VM_NAME}.\n` +
    "A 30-minute safety timer is active.\n" +
    `Planned deallocation: ${formatDhakaEpoch(deadline)}`
  );
}

async function requestDeallocate(env, source = "Telegram") {
  await deallocateVm(env);
  await mergeTags(env, {
    RunUntilEpoch: 0,
    RunUntilLocal: "none",
    WarningForEpoch: 0,
    LastPowerState: "deallocating"
  });

  return `🛑 ${source} DEALLOCATION request accepted for ${env.VM_NAME}.`;
}

async function extendRuntime(env, minutes) {
  const state = await getPowerState(env);
  if (state.code !== "running") {
    return `⚠️ ${env.VM_NAME} is not RUNNING, so there is no active runtime to extend.`;
  }

  const tags = await getTags(env);
  const now = epochNow();
  const oldDeadline = intTag(tags.RunUntilEpoch);
  const base = oldDeadline > now ? oldDeadline : now;
  const deadline = base + minutes * 60;

  await mergeTags(env, {
    RunUntilEpoch: deadline,
    RunUntilLocal: formatTagTime(deadline),
    WarningForEpoch: 0
  });

  await taskRpc(env, "/extend", { deadline });

  return (
    `✅ ${env.VM_NAME} extended by ${humanMinutes(minutes)}.\n` +
    `New planned deallocation: ${formatDhakaEpoch(deadline)}`
  );
}

async function handleTelegramUpdate(update, env) {
  try {
    const callback = update?.callback_query;
    if (callback) {
      const chatId = String(callback?.message?.chat?.id || "");
      if (chatId !== String(env.TELEGRAM_CHAT_ID)) return;

      const callbackId = callback.id;
      const raw = String(callback.data || "");
      const [action, expectedRaw] = raw.split("|", 2);
      const expectedDeadline = Number(expectedRaw || 0);

      if (action === "smartkeep15") {
        const result = await taskRpc(env, "/keep", { token: expectedRaw });
        await answerCallback(env, callbackId, result?.ok ? "Kept alive 15 minutes" : "Confirmation expired");
        if (result?.ok) await sendMessage(env, "✅ VM kept alive for another 15 minutes.");
        return;
      }
      if (action === "smartstop") {
        const result = await taskRpc(env, "/manual-stop", { token: expectedRaw });
        if (!result?.ok) {
          await answerCallback(env, callbackId, "Confirmation expired or Hermes is busy");
          return;
        }
        await answerCallback(env, callbackId, "Deallocating");
        await sendMessage(env, await requestDeallocate(env, "Smart confirmation"));
        return;
      }
      if (action === "status") {
        await answerCallback(env, callbackId, "Status sent");
        await sendMessage(env, await statusMessage(env));
        return;
      }

      const tags = await getTags(env);
      const currentDeadline = intTag(tags.RunUntilEpoch);
      if (expectedDeadline && currentDeadline !== expectedDeadline) {
        await answerCallback(env, callbackId, "This button has expired.");
        return;
      }

      const extensions = {
        keep30: 30,
        keep60: 60,
        keep120: 120,
        keep180: 180,
        keep240: 240
      };

      if (extensions[action]) {
        await answerCallback(env, callbackId, `Extended ${humanMinutes(extensions[action])}`);
        await sendMessage(env, await extendRuntime(env, extensions[action]));
        return;
      }

      if (action === "deallocate") {
        await answerCallback(env, callbackId, "Deallocating VM");
        await sendMessage(env, await requestDeallocate(env, "Telegram button"));
        return;
      }

      return;
    }

    const msg = update?.message;
    if (!msg) return;

    const chatId = String(msg?.chat?.id || "");
    if (chatId !== String(env.TELEGRAM_CHAT_ID)) return;

    const rawText = String(msg.text || "").trim();
    if (!rawText) return;

    const command = rawText.split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();

    if (command === "/start" || command === "/help") {
      await sendMessage(env, helpText());
      return;
    }

    if (command === "/status") {
      await sendMessage(env, await statusMessage(env));
      return;
    }

    if (command === "/startvm") {
      await sendMessage(env, await requestStart(env));
      return;
    }

    if (command === "/deallocate" || command === "/shutdown") {
      await sendMessage(env, await requestDeallocate(env));
      return;
    }

    const extensions = {
      "/keep30": 30,
      "/keep60": 60,
      "/keep120": 120,
      "/keep180": 180,
      "/keep240": 240
    };

    if (extensions[command]) {
      await sendMessage(env, await extendRuntime(env, extensions[command]));
      return;
    }

    if (command === "/autostart") {
      await handleAutoStartCommand(env, rawText);
      return;
    }

    const costDays = {
      "/cost1d": 1,
      "/cost2d": 2,
      "/cost3d": 3,
      "/cost7d": 7,
      "/cost30d": 30
    };

    if (costDays[command]) {
      await sendMessage(env, await costMessage(env, costDays[command]));
      return;
    }

    if (command === "/balance") {
      await sendMessage(env, await balanceMessage(env));
      return;
    }

    await sendMessage(env, "Unknown command. Send /help to see available commands.");
  } catch (err) {
    console.log("Telegram handler error", err?.stack || String(err));
    try {
      await sendMessage(env, `❌ Command failed: ${shortError(err)}`);
    } catch {}
  }
}

async function handleAutoStartCommand(env, rawText) {
  const parts = rawText.trim().split(/\s+/);
  const tags = await getTags(env);

  if (parts.length === 1 || String(parts[1]).toLowerCase() === "status") {
    await sendMessage(
      env,
      `⏰ Daily auto-start: ${autoStartText(tags)} (Bangladesh time)\n` +
        "Use /autostart HH:MM to change it.\n" +
        "Example: /autostart 07:30\n" +
        "Use /autostart off to disable."
    );
    return;
  }

  const value = String(parts[1]).toLowerCase();

  if (value === "off") {
    await mergeTags(env, { AutoStartEnabled: "false" });
    await sendMessage(env, "⏰ Daily auto-start is now OFF.");
    return;
  }

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    await sendMessage(
      env,
      "❌ Invalid time. Use 24-hour HH:MM, for example /autostart 07:30"
    );
    return;
  }

  const now = dhakaNowParts();
  const lastDate = value <= now.hhmm ? now.date : "pending";

  await mergeTags(env, {
    AutoStartEnabled: "true",
    AutoStartTime: value,
    AutoStartLastDate: lastDate
  });

  await sendMessage(
    env,
    `✅ Daily auto-start changed to ${formatHhmm12(value)} Bangladesh time.\n` +
      "Auto-started runs receive a fresh 30-minute safety timer."
  );
}

async function runScheduler(env) {
  try {
    let tags = await getTags(env);
    const nowEpoch = epochNow();
    const local = dhakaNowParts();

    if (!tags.AutoStartTime) {
      const baselineLast = local.hhmm >= "06:00" ? local.date : "pending";
      await mergeTags(env, {
        AutoStartEnabled: "true",
        AutoStartTime: "06:00",
        AutoStartLastDate: baselineLast
      });
      tags = await getTags(env);
    }

    let state = await getPowerState(env);
    const autoEnabled = String(tags.AutoStartEnabled ?? "true").toLowerCase() === "true";
    const autoTime = String(tags.AutoStartTime || "06:00");
    const autoLastDate = String(tags.AutoStartLastDate || "");

    if (
      autoEnabled &&
      autoLastDate !== local.date &&
      local.hhmm >= autoTime
    ) {
      if (state.code !== "running") {
        await startVm(env);
        const deadline = epochNow() + 30 * 60;

        await mergeTags(env, {
          RunUntilEpoch: deadline,
          RunUntilLocal: formatTagTime(deadline),
          WarningForEpoch: 0,
          LastPowerState: "starting",
          AutoStartLastDate: local.date
        });

        await sendMessage(
          env,
          "⏰ Daily AUTO-START triggered.\n" +
            `🟡 START request accepted for ${env.VM_NAME}.\n` +
            `Auto-start time: ${formatHhmm12(autoTime)} Bangladesh time\n` +
            `Planned DEALLOCATION: ${formatDhakaEpoch(deadline)}`
        );
      } else {
        await mergeTags(env, { AutoStartLastDate: local.date });
      }

      tags = await getTags(env);
      state = await getPowerState(env);
    }

    const lastState = String(tags.LastPowerState || "").toLowerCase();
    let deadline = intTag(tags.RunUntilEpoch);

    if (state.code === "running") {
      if (lastState === "starting") {
        await mergeTags(env, { LastPowerState: "running" });
      } else if (lastState !== "running") {
        if (deadline <= nowEpoch) {
          deadline = nowEpoch + 30 * 60;
          await mergeTags(env, {
            RunUntilEpoch: deadline,
            RunUntilLocal: formatTagTime(deadline),
            WarningForEpoch: 0,
            LastPowerState: "running"
          });
        } else {
          await mergeTags(env, { LastPowerState: "running" });
        }

        await sendMessage(
          env,
          "🟢 Manual/external VM ON detected.\n" +
            "Status: 🟢 RUNNING\n" +
            `Planned deallocation: ${formatDhakaEpoch(deadline)}`
        );
      }

      tags = await getTags(env);
      deadline = intTag(tags.RunUntilEpoch);

      if (deadline <= 0) {
        deadline = nowEpoch + 30 * 60;
        await mergeTags(env, {
          RunUntilEpoch: deadline,
          RunUntilLocal: formatTagTime(deadline),
          WarningForEpoch: 0
        });
      }

      const remaining = deadline - epochNow();
      const warnedFor = intTag(tags.WarningForEpoch);

      // Task-aware shutdown takes precedence. Legacy timer stays as fallback
      // until the first authenticated task event reaches this Worker.
      if (env.HERMES_TASK_STATE && await handleSmartScheduler(env)) return;

      if (remaining <= 0) {
        await deallocateVm(env);
        await mergeTags(env, {
          RunUntilEpoch: 0,
          RunUntilLocal: "none",
          WarningForEpoch: 0,
          LastPowerState: "deallocating"
        });

        await sendMessage(
          env,
          `🛑 ${env.VM_NAME}: safety timer expired. DEALLOCATION requested.`
        );
        return;
      }

      if (remaining <= 300 && warnedFor !== deadline) {
        await sendWarning(env, deadline);
      }

      return;
    }

    if (state.code === "stopped") {
      await sendMessage(
        env,
        "🟠 VM is STOPPED but NOT DEALLOCATED.\n" +
          "Requesting DEALLOCATION now to release compute allocation."
      );

      await deallocateVm(env);
      await mergeTags(env, {
        RunUntilEpoch: 0,
        RunUntilLocal: "none",
        WarningForEpoch: 0,
        LastPowerState: "deallocating"
      });
      return;
    }

    if (state.code === "deallocated") {
      await taskRpc(env, "/reset");
      if (lastState === "deallocating") {
        await mergeTags(env, {
          RunUntilEpoch: 0,
          RunUntilLocal: "none",
          WarningForEpoch: 0,
          LastPowerState: "deallocated"
        });
      } else if (lastState && lastState !== "deallocated") {
        await mergeTags(env, {
          RunUntilEpoch: 0,
          RunUntilLocal: "none",
          WarningForEpoch: 0,
          LastPowerState: "deallocated"
        });

        await sendMessage(
          env,
          "🔴 Manual/external VM DEALLOCATION detected.\n" +
            "Status: 🔴 DEALLOCATED\n" +
            "Compute allocation has been released."
        );
      } else if (!lastState) {
        await mergeTags(env, { LastPowerState: "deallocated" });
      }
    }
  } catch (err) {
    console.log("Scheduler error", err?.stack || String(err));
  }
}

async function queryCostWithRetry(env, url, body, maxAttempts = 4) {
  const token = await getAzureToken(env);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const text = await res.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (res.ok) {
      return data;
    }

    const retryAfterRaw =
      res.headers.get("x-ms-ratelimit-microsoft.consumption-retry-after") ||
      res.headers.get("retry-after");

    let retrySeconds = Number.parseInt(String(retryAfterRaw || ""), 10);
    if (!Number.isFinite(retrySeconds) || retrySeconds < 1) {
      retrySeconds = Math.min(2 ** attempt, 8);
    }

    if ((res.status === 429 || res.status === 503) && attempt < maxAttempts) {
      const waitSeconds = Math.min(retrySeconds, 10);
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }

    const hint =
      res.status === 429
        ? "Azure Cost Management temporarily throttled the request. Please try again after a short wait."
        : res.status === 503
          ? "Azure Cost Management is temporarily unavailable. Please try again shortly."
          : "";

    throw new Error(
      `Azure Cost Management ${res.status}: ${safeText(data)}${hint ? " " + hint : ""}`
    );
  }

  throw new Error("Azure Cost Management query failed after retries.");
}

async function costMessage(env, days) {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

    const scope =
      `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${env.RESOURCE_GROUP}`;

    const body = {
      type: "Usage",
      timeframe: "Custom",
      timePeriod: {
        from: start.toISOString(),
        to: end.toISOString()
      },
      dataset: {
        granularity: "None",
        aggregation: {
          totalCost: {
            name: "PreTaxCost",
            function: "Sum"
          }
        }
      }
    };

    const url =
      `${ARM}${scope}/providers/Microsoft.CostManagement/query?api-version=${COST_API}`;

    const data = await queryCostWithRetry(env, url, body);

    const columns = data?.properties?.columns || [];
    const rows = data?.properties?.rows || [];

    if (!rows.length) {
      return (
        `💰 Cost — last ${days} day(s)\n` +
        `Scope: ${env.RESOURCE_GROUP}\n` +
        "No cost data is available yet for this period."
      );
    }

    const names = columns.map((c) => String(c?.name || "").toLowerCase());
    const costIndex = ["pretaxcost", "totalcost", "cost"]
      .map((n) => names.indexOf(n))
      .find((i) => i >= 0);
    const currencyIndex = names.indexOf("currency");

    if (costIndex === undefined || costIndex < 0) {
      return "❌ Azure returned cost data but no recognized cost column.";
    }

    let total = 0;
    const currencies = new Set();

    for (const row of rows) {
      total += Number(row[costIndex] || 0);
      if (currencyIndex >= 0 && row[currencyIndex]) {
        currencies.add(String(row[currencyIndex]));
      }
    }

    const currency = [...currencies].join(", ") || "currency unavailable";

    return (
      `💰 Cost — last ${days} day(s)\n` +
      `Scope: ${env.RESOURCE_GROUP}\n` +
      `Latest available cost: ${total.toFixed(4)} ${currency}\n` +
      "ℹ️ Azure cost data may arrive with a delay."
    );
  } catch (err) {
    const msg = String(err?.message || err || "");

    if (msg.includes("429")) {
      return (
        `⏳ Azure temporarily rate-limited the cost query for the last ${days} day(s).\n` +
        "Please wait a little and try the command again."
      );
    }

    return (
      `❌ Cost query failed for the last ${days} day(s).\n` +
      `Error: ${shortError(err)}`
    );
  }
}

async function queryCostRange(env, scope, start, end) {
  const body = {
    type: "Usage",
    timeframe: "Custom",
    timePeriod: {
      from: start.toISOString(),
      to: end.toISOString()
    },
    dataset: {
      granularity: "None",
      aggregation: {
        totalCost: {
          name: "PreTaxCost",
          function: "Sum"
        }
      }
    }
  };

  const url =
    `${ARM}${scope}/providers/Microsoft.CostManagement/query?api-version=${COST_API}`;

  const data = await queryCostWithRetry(env, url, body);
  const columns = data?.properties?.columns || [];
  const rows = data?.properties?.rows || [];

  if (!rows.length) {
    return { total: 0, currency: "USD" };
  }

  const names = columns.map((col) => String(col?.name || "").toLowerCase());
  const costIndex = ["pretaxcost", "totalcost", "cost"]
    .map((name) => names.indexOf(name))
    .find((index) => index >= 0);
  const currencyIndex = names.indexOf("currency");

  if (costIndex === undefined || costIndex < 0) {
    throw new Error("Azure returned cost data without a recognized cost column.");
  }

  let total = 0;
  let currency = "USD";

  for (const row of rows) {
    total += Number(row[costIndex] || 0);
    if (currencyIndex >= 0 && row[currencyIndex]) {
      currency = String(row[currencyIndex]);
    }
  }

  return { total, currency };
}

async function queryTotalCostForScope(env, scope, creditStartDate) {
  const start = new Date(`${creditStartDate}T00:00:00.000Z`);
  const end = new Date();

  if (Number.isNaN(start.getTime())) {
    throw new Error("AZURE_CREDIT_START_DATE must use YYYY-MM-DD format.");
  }

  if (start > end) {
    throw new Error("AZURE_CREDIT_START_DATE cannot be in the future.");
  }

  // Azure Cost Management rejects custom ranges longer than one year.
  // Split the credit period into chunks safely below that limit.
  const maxChunkMs = 364 * 24 * 60 * 60 * 1000;

  let cursor = new Date(start);
  let total = 0;
  let currency = "USD";

  while (cursor < end) {
    const chunkEnd = new Date(
      Math.min(cursor.getTime() + maxChunkMs, end.getTime())
    );

    const part = await queryCostRange(env, scope, cursor, chunkEnd);
    total += Number(part?.total || 0);

    if (part?.currency) {
      const partCurrency = String(part.currency).toUpperCase();

      if (currency !== "USD" && partCurrency !== currency) {
        throw new Error("Azure returned mixed currencies across cost periods.");
      }

      currency = partCurrency;
    }

    if (chunkEnd.getTime() >= end.getTime()) break;

    // Move forward by 1 ms so adjacent chunks do not overlap.
    cursor = new Date(chunkEnd.getTime() + 1);
  }

  return { total, currency };
}

async function balanceMessage(env) {
  const initialCredit = Number(env.AZURE_INITIAL_CREDIT || 100);
  const creditStartDate = String(env.AZURE_CREDIT_START_DATE || "").trim();

  if (!creditStartDate) {
    return (
      "💳 Azure for Students — estimated balance\n" +
      "❌ AZURE_CREDIT_START_DATE is not configured."
    );
  }

  const subscriptionScope = `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}`;
  const resourceGroupScope =
    `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${env.RESOURCE_GROUP}`;

  let result;
  let scopeLabel = "Entire subscription";
  let limitedScope = false;

  try {
    result = await queryTotalCostForScope(
      env,
      subscriptionScope,
      creditStartDate
    );
  } catch (subscriptionErr) {
    try {
      result = await queryTotalCostForScope(
        env,
        resourceGroupScope,
        creditStartDate
      );
      scopeLabel = env.RESOURCE_GROUP;
      limitedScope = true;
    } catch (resourceGroupErr) {
      return (
        "💳 Azure for Students — estimated balance\n" +
        "❌ Cost data could not be read, so an estimate cannot be calculated.\n" +
        `Error: ${shortError(resourceGroupErr)}`
      );
    }
  }

  const used = Math.max(0, Number(result?.total || 0));
  const currency = String(result?.currency || "USD").toUpperCase();

  if (currency !== "USD") {
    return (
      "💳 Azure for Students — estimated balance\n" +
      `❌ Azure returned cost data in ${currency}, but the student credit baseline is 100 USD.\n` +
      "No estimate was calculated to avoid mixing currencies."
    );
  }

  const remaining = Math.max(0, initialCredit - used);

  const lines = [
    "💳 Azure for Students — estimated balance",
    `Estimated remaining: ${formatMoney(remaining)} USD`,
    `Estimated used: ${formatMoney(used)} USD`,
    `Initial credit: ${formatMoney(initialCredit)} USD`,
    `Credit start date: ${creditStartDate}`,
    `Cost scope: ${scopeLabel}`,
    "ℹ️ Estimate = initial credit − Azure Cost Management usage since the credit start date."
  ];

  if (limitedScope) {
    lines.push(
      `⚠️ Subscription-wide cost was not accessible, so this estimate only includes ${env.RESOURCE_GROUP}. Costs outside this resource group are not included.`
    );
  }

  lines.push("ℹ️ Azure cost data can arrive with a delay, so this is not the exact portal balance.");

  return lines.join("\n");
}

function helpText() {
  return [
    "⚙️ VM_Hermes commands",
    "",
    "/status — VM status, deallocation time, auto-start",
    "/startvm — start VM with 30-minute timer",
    "/deallocate — deallocate now",
    "/keep30 — +30 minutes",
    "/keep60 — +1 hour",
    "/keep120 — +2 hours",
    "/keep180 — +3 hours",
    "/keep240 — +4 hours",
    "/autostart HH:MM — set daily auto-start",
    "/autostart off — disable auto-start",
    "/cost1d — last 1 day cost",
    "/cost2d — last 2 days cost",
    "/cost3d — last 3 days cost",
    "/cost7d — last 7 days cost",
    "/cost30d — last 30 days cost",
    "/balance — Azure credit balance",
    "/help — show commands"
  ].join("\n");
}

function epochNow() {
  return Math.floor(Date.now() / 1000);
}

function intTag(value) {
  const n = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(n) ? n : 0;
}

function stateLabel(code, display) {
  if (code === "running") return "🟢 RUNNING";
  if (code === "deallocated") return "🔴 DEALLOCATED";
  if (code === "stopped") return "🟠 STOPPED (NOT DEALLOCATED)";
  if (code === "starting") return "🟡 STARTING";
  if (code === "deallocating") return "🟡 DEALLOCATING";
  return display || "Unknown";
}

function remainingText(deadline) {
  const seconds = Math.max(0, Number(deadline) - epochNow());
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function humanMinutes(minutes) {
  if (minutes === 30) return "30 minutes";
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}

function formatDhakaEpoch(epoch) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }).format(new Date(Number(epoch) * 1000));
}

function formatTagTime(epoch) {
  const p = dhakaParts(new Date(Number(epoch) * 1000));
  return `${p.date}_${p.hhmm}`;
}

function dhakaNowParts() {
  return dhakaParts(new Date());
}

function dhakaParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hhmm: `${map.hour}:${map.minute}`
  };
}

function autoStartText(tags) {
  const enabled = String(tags.AutoStartEnabled ?? "true").toLowerCase() === "true";
  if (!enabled) return "OFF";
  return formatHhmm12(String(tags.AutoStartTime || "06:00"));
}

function formatHhmm12(hhmm) {
  const [hRaw, mRaw] = String(hhmm).split(":");
  let h = Number(hRaw);
  const m = String(mRaw || "00").padStart(2, "0");
  const suffix = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${String(h).padStart(2, "0")}:${m} ${suffix}`;
}

function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : String(value);
}

function safeText(value) {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 700 ? text.slice(0, 700) + "…" : text;
  } catch {
    return String(value);
  }
}

function shortError(err) {
  const text = String(err?.message || err || "Unknown error");
  return text.length > 500 ? text.slice(0, 500) + "…" : text;
}


function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
