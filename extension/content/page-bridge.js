// CommercialBlock page bridge.
// Runs in the page's own JavaScript world so it can talk to YouTube TV's player
// (read the break list, read the playback time, seek). It has no extension
// privileges; it only exchanges small messages with content.js.
(() => {
  "use strict";

  const FROM_PAGE = "commercialblock-page";
  const FROM_CONTENT = "commercialblock-content";
  const TICK_MS = 250;

  let player = null;
  let lastPlayerSearch = 0;
  let lastVideoKey = "";
  let currentId = null;
  let idSince = 0;

  function urlVideoId() {
    const m = location.pathname.match(/^\/watch\/([A-Za-z0-9_-]{6,32})/);
    return m ? m[1] : null;
  }

  function isPlayer(el) {
    return !!el && typeof el.getPlayerResponse === "function";
  }

  function findPlayer() {
    if (isPlayer(player) && player.isConnected) return player;
    player = null;
    const quick = document.querySelector("#movie_player, .html5-video-player");
    if (isPlayer(quick)) return (player = quick);
    // Full scan is expensive; do it at most every 2 seconds.
    const now = Date.now();
    if (now - lastPlayerSearch < 2000) return null;
    lastPlayerSearch = now;
    const all = document.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) {
      if (isPlayer(all[i])) return (player = all[i]);
    }
    return null;
  }

  function getVideo() {
    // The main recording lives inside YouTube's standard player. The page also
    // holds many small preview videos (ytu-tenx-video) that must be ignored.
    const main = document.querySelector("#movie_player video, .html5-video-container video");
    if (main) return main;
    const vids = [...document.querySelectorAll("video")].filter((v) => !v.closest("ytu-tenx-video"));
    if (vids.length <= 1) return vids[0] || null;
    let best = null;
    let bestArea = -1;
    vids.forEach((v) => {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    });
    return best;
  }

  function safe(fn, fallback) {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }

  function parsePlacements(resp) {
    const out = [];
    const list = (resp && resp.adPlacements) || [];
    for (const p of list) {
      const r = p && p.adPlacementRenderer;
      const c = r && r.config && r.config.adPlacementConfig;
      if (!c || c.kind !== "AD_PLACEMENT_KIND_MILLISECONDS" || !c.adTimeOffset) continue;
      const s = Number(c.adTimeOffset.offsetStartMilliseconds);
      const e = Number(c.adTimeOffset.offsetEndMilliseconds);
      if (Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e > s) {
        out.push({ start: s / 1000, end: e / 1000 });
      }
    }
    return out;
  }

  function currentTime(p, v) {
    const t = p && safe(() => p.getCurrentTime(), NaN);
    if (Number.isFinite(t)) return { time: t, clock: "player" };
    if (v && Number.isFinite(v.currentTime)) return { time: v.currentTime, clock: "video" };
    return { time: NaN, clock: "none" };
  }

  function post(msg) {
    msg.source = FROM_PAGE;
    window.postMessage(msg, location.origin);
  }

  function tick() {
    const id = urlVideoId();
    if (!id) {
      if (lastVideoKey !== "none") {
        lastVideoKey = "none";
        post({ type: "video", videoId: null });
      }
      return;
    }
    const p = findPlayer();
    const v = getVideo();
    const resp = p ? safe(() => p.getPlayerResponse(), null) : null;
    const details = (resp && resp.videoDetails) || {};

    // Only trust the player response once it matches the page URL (avoids
    // using a stale response right after navigating to another recording).
    if (id !== currentId) {
      currentId = id;
      idSince = Date.now();
    }

    if (!(resp && details.videoId === id)) {
      // No usable player data yet. After a few seconds, fall back to the bare
      // <video> element so community breaks still work.
      if (!lastVideoKey.startsWith(id + "|") && Date.now() - idSince > 5000 && v && Number.isFinite(v.duration)) {
        lastVideoKey = id + "|fallback";
        post({
          type: "video",
          videoId: id,
          title: "",
          channelId: "",
          lengthSeconds: v.duration,
          isLive: false,
          placements: [],
          fallback: true
        });
      }
    } else {
      const placements = parsePlacements(resp);
      const length = Number(details.lengthSeconds) || null;
      const isLive = details.isLive === true;
      const key = [id, length, isLive, JSON.stringify(placements)].join("|");
      if (key !== lastVideoKey) {
        lastVideoKey = key;
        post({
          type: "video",
          videoId: id,
          title: String(details.title || "").slice(0, 200),
          channelId: String(details.channelId || "").slice(0, 64),
          lengthSeconds: length,
          isLive,
          placements
        });
      }
    }

    if (lastVideoKey.startsWith(id + "|")) {
      const ct = currentTime(p, v);
      const dur = (p && safe(() => p.getDuration(), NaN)) || (v && v.duration);
      const prog = p && typeof p.getProgressState === "function" ? safe(() => p.getProgressState(), null) : null;
      post({
        type: "time",
        videoId: id,
        time: ct.time,
        clock: ct.clock,
        duration: Number.isFinite(dur) ? dur : null,
        allowSeeking: prog && prog.allowSeeking === false ? false : true,
        seekableEnd: prog && Number.isFinite(prog.seekableEnd) ? prog.seekableEnd : null,
        paused: v ? v.paused : null,
        playbackRate: v ? v.playbackRate : 1
      });
    }
  }

  function seek(target) {
    const p = findPlayer();
    if (p && typeof p.seekTo === "function") {
      try {
        p.seekTo(target, true);
        return "player";
      } catch (_) {
        /* fall through */
      }
    }
    const v = getVideo();
    if (v) {
      v.currentTime = target;
      return "video";
    }
    return "none";
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.source !== FROM_CONTENT) return;
    if (d.type === "seek" && Number.isFinite(d.time) && d.time >= 0) {
      const method = seek(d.time);
      post({ type: "seeked", requested: d.time, method });
    } else if (d.type === "hello") {
      lastVideoKey = ""; // force a fresh "video" message
    }
  });

  setInterval(tick, TICK_MS);
})();
