"use strict";

const DEFAULTS = {
  enabled: true,
  useYouTube: true,
  useCommunity: true,
  autoClickSkipAd: true,
  skipOnDemandAds: true,
  showNotice: true,
  showMarkers: true,
  debug: false
};
const KEYS = Object.keys(DEFAULTS);
const $ = (id) => document.getElementById(id);

async function loadSettings() {
  const { settings } = await browser.storage.local.get("settings");
  const s = { ...DEFAULTS, ...(settings || {}) };
  for (const k of KEYS) {
    $(k).checked = !!s[k];
    $(k).addEventListener("change", save);
  }
  document.body.classList.toggle("off", !s.enabled);
}

async function save() {
  const s = {};
  for (const k of KEYS) s[k] = $(k).checked;
  document.body.classList.toggle("off", !s.enabled);
  await browser.storage.local.set({ settings: s });
}

async function loadStats() {
  const { stats } = await browser.storage.local.get("stats");
  const s = stats || {};
  $("st-skips").textContent = String((s.skips || 0) + (s.adsSkipped || 0));
  $("st-saved").textContent = CBSegments.formatTime(s.secondsSaved || 0);
  $("st-subs").textContent = String(s.submissions || 0);
}

let current = { videoId: null, title: "" };
let serverOk = false;

function fmt(sec) {
  return CBSegments.formatTime(sec);
}

async function renderSaved() {
  const { localSegments } = await browser.storage.local.get("localSegments");
  const all = localSegments || {};
  const ids = Object.keys(all).filter((id) => (all[id] || []).length);
  ids.sort((a, b) => (b === current.videoId) - (a === current.videoId));
  const list = $("saved-list");
  list.replaceChildren();
  let total = 0;
  for (const id of ids) {
    const items = all[id];
    const head = document.createElement("li");
    head.className = "rec";
    const named = items.find((s) => s.title);
    head.textContent = (id === current.videoId ? current.title || "This recording" : named ? named.title : "Recording " + id) +
      (id === current.videoId ? "  (open now)" : "");
    list.appendChild(head);
    items.forEach((s, i) => {
      total++;
      const li = document.createElement("li");
      const t = document.createElement("span");
      t.className = "times";
      t.textContent = fmt(s.start) + " → " + fmt(s.end) + "  (" + fmt(s.end - s.start) + ")";
      const del = document.createElement("button");
      del.className = "del";
      del.type = "button";
      del.textContent = "✕";
      del.title = "Delete this saved break";
      del.addEventListener("click", async () => {
        const fresh = (await browser.storage.local.get("localSegments")).localSegments || {};
        (fresh[id] || []).splice(i, 1);
        if (fresh[id] && !fresh[id].length) delete fresh[id];
        await browser.storage.local.set({ localSegments: fresh });
        renderSaved();
      });
      li.append(t, del);
      list.appendChild(li);
    });
  }
  $("saved-empty").hidden = total > 0;
  $("export").disabled = total === 0;
  $("upload").hidden = !serverOk || total === 0;
}

async function exportSaved() {
  const { localSegments } = await browser.storage.local.get("localSegments");
  const all = localSegments || {};
  const breaks = [];
  for (const id of Object.keys(all)) {
    for (const s of all[id] || []) {
      breaks.push({
        recordingId: id,
        recordingUrl: "https://tv.youtube.com/watch/" + id,
        title: s.title || (id === current.videoId ? current.title : ""),
        start: s.start,
        end: s.end,
        startTime: fmt(s.start),
        endTime: fmt(s.end),
        length: fmt(s.end - s.start),
        recordingLengthSeconds: s.duration || null,
        savedAt: s.savedAt || null
      });
    }
  }
  const data = { app: "CommercialBlock", version: 1, exportedAt: new Date().toISOString(), breaks };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "commercialblock-saved-breaks-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  $("saved-msg").textContent = "Downloaded " + breaks.length + " break" + (breaks.length === 1 ? "" : "s") + ".";
}

async function uploadSaved() {
  const btn = $("upload");
  btn.disabled = true;
  $("saved-msg").textContent = "Sharing…";
  const fresh = (await browser.storage.local.get("localSegments")).localSegments || {};
  let shared = 0;
  let failed = 0;
  for (const id of Object.keys(fresh)) {
    const keep = [];
    for (const s of fresh[id]) {
      const res = await browser.runtime.sendMessage({
        type: "submit", videoId: id, start: s.start, end: s.end, duration: s.duration || null, channelId: s.channelId || ""
      }).catch((e) => ({ ok: false, error: String(e) }));
      if (res && res.ok) shared++;
      else { failed++; keep.push(s); }
    }
    if (keep.length) fresh[id] = keep;
    else delete fresh[id];
  }
  await browser.storage.local.set({ localSegments: fresh });
  if (shared) {
    const { stats } = await browser.storage.local.get("stats");
    await browser.storage.local.set({ stats: { ...(stats || {}), submissions: ((stats && stats.submissions) || 0) + shared } });
  }
  $("saved-msg").textContent = "Shared " + shared + "." + (failed ? " " + failed + " couldn't be sent and are still saved here." : "");
  btn.disabled = false;
  renderSaved();
  loadStats();
}

async function loadCurrent() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https:\/\/tv\.youtube\.com\/watch\//.test(tab.url)) return;
  let st;
  try {
    st = await browser.tabs.sendMessage(tab.id, { type: "status" });
  } catch (_) {
    $("now-empty").textContent = "Reload the YouTube TV tab to start CommercialBlock.";
    return;
  }
  if (!st || !st.videoId) {
    $("now-empty").textContent = "Waiting for the recording to load…";
    return;
  }
  current = { videoId: st.videoId, title: st.title || "" };
  $("now-empty").hidden = true;
  $("now-info").hidden = false;
  $("now-title").textContent = st.title || "This recording";
  $("yt-count").textContent = String(st.youtubeBreaks);
  $("cm-count").textContent = String(st.communityBreaks);
  const yt = st.youtubeList || [];
  $("yt-list").textContent = yt.length
    ? "YouTube TV marks: " + yt.map((p) => fmt(p.start) + "–" + fmt(p.end)).join(", ")
    : "";
  const notes = {
    "not-configured": "Community sharing isn't set up yet. Breaks you mark are saved on this computer only.",
    error: "Couldn't reach the community server right now.",
    off: "Community breaks are turned off.",
    loading: "Loading community breaks…"
  };
  let note = notes[st.communityStatus] || "";
  if (st.fallback) note = (note ? note + " " : "") + "YouTube TV's break list wasn't available for this recording.";
  $("now-note").textContent = note;
}

async function loadServer() {
  let res;
  try {
    res = await browser.runtime.sendMessage({ type: "serverStatus" });
  } catch (_) {
    res = { ok: false };
  }
  serverOk = !!res.ok;
  $("server").textContent = res.notConfigured
    ? "Community server: not set up"
    : res.ok ? "Community server: connected" : "Community server: can't connect";
}

$("export").addEventListener("click", exportSaved);
$("upload").addEventListener("click", uploadSaved);
loadSettings();
loadStats();
Promise.all([loadCurrent().catch(() => {}), loadServer().catch(() => {})]).then(renderSaved);
