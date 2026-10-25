// CommercialBlock background script: talks to the Supabase database.
"use strict";

const TIMEOUT_MS = 8000;
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // videoId -> {at, segments}

function configured() {
  return !!(typeof CB_CONFIG !== "undefined" && CB_CONFIG.SUPABASE_URL && CB_CONFIG.SUPABASE_ANON_KEY);
}

async function getUserId() {
  const { userId } = await browser.storage.local.get("userId");
  if (userId) return userId;
  const id = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await browser.storage.local.set({ userId: id });
  return id;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function rpc(name, args) {
  const base = CB_CONFIG.SUPABASE_URL.replace(/\/+$/, "");
  const key = CB_CONFIG.SUPABASE_ANON_KEY;
  const headers = { "Content-Type": "application/json", apikey: key };
  // Legacy "anon" keys are JWTs and also go in the Authorization header.
  // New "sb_publishable_" keys must only be sent as apikey.
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(base + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
      signal: ctrl.signal,
      credentials: "omit"
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
    if (!res.ok) {
      const msg = (body && (body.message || body.hint)) || "http_" + res.status;
      throw new Error(msg);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

async function getSegments(videoId, duration, force) {
  if (!configured()) return { ok: false, notConfigured: true };
  if (!VIDEO_ID_RE.test(videoId || "")) return { ok: false, error: "invalid_video" };
  const hit = cache.get(videoId);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return { ok: true, segments: hit.segments };
  // Privacy: only the first 4 characters of the recording's hash are sent,
  // so the server can't tell exactly which recording you're watching.
  const hash = await sha256Hex(videoId);
  const rows = await rpc("get_segments", { hash_prefix: hash.slice(0, 4) });
  const segments = (Array.isArray(rows) ? rows : [])
    .filter((r) => r.video_id === videoId)
    .filter((r) => !duration || !r.video_duration || Math.abs(Number(r.video_duration) - duration) <= 5)
    .map((r) => ({ id: r.id, start: Number(r.start_time), end: Number(r.end_time), votes: Number(r.votes) || 0 }));
  cache.set(videoId, { at: Date.now(), segments });
  return { ok: true, segments };
}

async function submit(msg) {
  if (!configured()) return { ok: false, notConfigured: true };
  if (!VIDEO_ID_RE.test(msg.videoId || "")) return { ok: false, error: "invalid" };
  const id = await rpc("submit_segment", {
    p_user_id: await getUserId(),
    p_video_id: msg.videoId,
    p_start: Math.round(msg.start * 100) / 100,
    p_end: Math.round(msg.end * 100) / 100,
    p_duration: Number.isFinite(msg.duration) ? Math.round(msg.duration * 100) / 100 : null,
    p_channel_id: msg.channelId ? String(msg.channelId).slice(0, 64) : null
  });
  cache.delete(msg.videoId);
  return { ok: true, id };
}

async function vote(msg) {
  if (!configured()) return { ok: false, notConfigured: true };
  if (![1, -1, 0].includes(msg.value)) return { ok: false, error: "invalid" };
  const score = await rpc("vote_segment", {
    p_user_id: await getUserId(),
    p_segment_id: msg.segmentId,
    p_value: msg.value
  });
  cache.clear();
  return { ok: true, score };
}

browser.runtime.onMessage.addListener((msg) => {
  const run = async () => {
    try {
      if (msg.type === "getSegments") return await getSegments(msg.videoId, msg.duration, msg.force);
      if (msg.type === "submit") return await submit(msg);
      if (msg.type === "vote") return await vote(msg);
      if (msg.type === "serverStatus") {
        if (!configured()) return { ok: false, notConfigured: true };
        await rpc("get_segments", { hash_prefix: "0000" });
        return { ok: true };
      }
      return { ok: false, error: "unknown_message" };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };
  return run();
});
