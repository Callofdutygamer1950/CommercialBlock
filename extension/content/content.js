// CommercialBlock content script: skipping, marking UI, progress-bar markers.
(() => {
  "use strict";

  const S = globalThis.CBSegments;
  const FROM_PAGE = "commercialblock-page";
  const FROM_CONTENT = "commercialblock-content";

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

  let settings = { ...DEFAULTS };
  let myVotes = {}; // segmentId -> 1 | -1
  let localSegments = {}; // videoId -> [{start, end}] (used when no server is set up)

  const state = {
    videoId: null,
    info: null,
    time: NaN,
    duration: null,
    paused: true,
    allowSeeking: true,
    seekableEnd: null,
    community: [],
    communityPicked: [],
    communityStatus: "idle", // idle | loading | ok | off | not-configured | error
    ranges: [],
    ignored: new Set(),
    failures: {},
    lastSkipAt: 0,
    pendingCheck: null,
    mark: null, // {phase: "started" | "review", start, end, error}
    lastMouse: 0,
    lastAdClick: 0,
    markersKey: "",
    ad: { active: false }
  };

  function log(...args) {
    if (settings.debug) console.log("[CommercialBlock]", ...args);
  }

  // ---------- page bridge ----------

  function toPage(msg) {
    msg.source = FROM_CONTENT;
    window.postMessage(msg, location.origin);
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.source !== FROM_PAGE) return;
    if (d.type === "video") onVideo(d);
    else if (d.type === "time") onTime(d);
    else if (d.type === "seeked") log("seeked to", d.requested, "via", d.method);
  });

  function onVideo(d) {
    if (!d.videoId) {
      state.videoId = null;
      state.info = null;
      state.ranges = [];
      cancelMark();
      render();
      return;
    }
    const changed = d.videoId !== state.videoId;
    state.videoId = d.videoId;
    state.info = {
      title: d.title || "",
      channelId: d.channelId || "",
      lengthSeconds: Number.isFinite(d.lengthSeconds) ? d.lengthSeconds : null,
      isLive: !!d.isLive,
      placements: Array.isArray(d.placements) ? d.placements : [],
      fallback: !!d.fallback
    };
    log("recording", d.videoId, "YouTube TV breaks:", state.info.placements, d.fallback ? "(no player data)" : "");
    if (changed) {
      state.ignored = new Set();
      state.failures = {};
      state.community = [];
      state.pendingCheck = null;
      cancelMark();
      loadCommunity();
    }
    rebuild();
  }

  function onTime(d) {
    if (d.videoId !== state.videoId) return;
    state.time = d.time;
    state.timeAt = Date.now();
    state.playbackRate = Number.isFinite(d.playbackRate) && d.playbackRate > 0 ? d.playbackRate : 1;
    state.duration = d.duration || (state.info && state.info.lengthSeconds) || null;
    state.paused = d.paused;
    state.allowSeeking = d.allowSeeking !== false;
    state.seekableEnd = d.seekableEnd;
    tick();
  }

  // ---------- data ----------

  function duration() {
    return state.duration || (state.info && state.info.lengthSeconds) || null;
  }

  async function loadCommunity(force) {
    const vid = state.videoId;
    if (!vid) return;
    if (!settings.useCommunity) {
      state.community = [];
      state.communityStatus = "off";
      rebuild();
      return;
    }
    state.communityStatus = "loading";
    let res;
    try {
      res = await browser.runtime.sendMessage({ type: "getSegments", videoId: vid, duration: state.info && state.info.lengthSeconds, force: !!force });
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    if (vid !== state.videoId) return; // user moved on
    const local = (localSegments[vid] || []).map((s, i) => ({ id: "local-" + i, start: s.start, end: s.end, votes: 1, local: true }));
    if (res && res.ok) {
      state.community = res.segments.concat(local);
      state.communityStatus = "ok";
    } else {
      state.community = local;
      state.communityStatus = res && res.notConfigured ? "not-configured" : "error";
      if (!(res && res.notConfigured)) log("couldn't load community breaks:", res && res.error);
    }
    log("community breaks:", state.community);
    rebuild();
  }

  function rebuild() {
    const dur = duration();
    const yt = settings.useYouTube && state.info ? state.info.placements : [];
    state.communityPicked = settings.useCommunity ? S.pickCommunity(state.community, dur) : [];
    state.ranges = S.buildSkipRanges(yt, state.communityPicked, dur);
    state.markersKey = "";
    render();
  }

  // Nothing from private windows is ever written to disk (Mozilla policy).
  // Content scripts can't tell on their own, so ask the background script,
  // which sees the tab. Assume private until it answers.
  let PRIVATE = true;
  browser.runtime.sendMessage({ type: "isPrivate" })
    .then((res) => { PRIVATE = !!(res && res.private === true); })
    .catch(() => { PRIVATE = false; });

  function bumpStats(delta) {
    if (PRIVATE) return;
    browser.storage.local.get("stats").then(({ stats }) => {
      const s = Object.assign({ skips: 0, secondsSaved: 0, adsSkipped: 0, submissions: 0, votes: 0 }, stats || {});
      for (const k of Object.keys(delta)) s[k] = (s[k] || 0) + delta[k];
      return browser.storage.local.set({ stats: s });
    }).catch(() => {});
  }

  // ---------- skipping ----------

  function tick() {
    const now = Date.now();

    if (settings.enabled && settings.autoClickSkipAd) clickSkipAdButton(now);

    // Did the last skip actually work?
    const pc = state.pendingCheck;
    if (pc && now - pc.at > 2000) {
      state.pendingCheck = null;
      if (Number.isFinite(state.time) && state.time < pc.target - 3 && state.time >= pc.range.start - 1) {
        const n = (state.failures[pc.range.key] = (state.failures[pc.range.key] || 0) + 1);
        log("skip didn't take (attempt " + n + ")");
        if (n >= 2) {
          state.ignored.add(pc.range.key);
          showNotice({ failed: true });
        }
      } else {
        bumpStats({ skips: 1, secondsSaved: Math.max(0, pc.saved) });
      }
    }

    if (settings.enabled && !state.mark && !state.pendingCheck && !state.ad.active && state.paused === false && state.allowSeeking && now - state.lastSkipAt > 1500) {
      const r = S.findSkip(state.time, state.ranges, state.ignored);
      if (r) {
        let target = r.end + 0.05;
        const limit = state.seekableEnd || duration();
        if (limit && target > limit - 1) {
          // The break runs past what has been recorded so far; don't jump to
          // the live edge. Try again later.
          log("break ends past the recorded part; not skipping yet");
        } else {
          const saved = target - state.time;
          toPage({ type: "seek", time: target });
          state.lastSkipAt = now;
          state.pendingCheck = { at: now, target, range: r, saved };
          log("skipping", S.formatTime(state.time), "→", S.formatTime(target), r.sources);
          if (!state.failures[r.key]) showNotice({ range: r, from: state.time, saved });
        }
      }
    }

    render();
  }

  function clickSkipAdButton(now) {
    if (now - state.lastAdClick < 1000) return;
    const btn = document.querySelector("button.skip-ad-button");
    if (!btn || btn.disabled) return;
    const r = btn.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    state.lastAdClick = now;
    btn.click();
    log("clicked YouTube TV's Skip ad button");
    bumpStats({ adsSkipped: 1 });
  }

  // ---------- on-demand ads ----------
  // On-demand (non-DVR) episodes play ads as separate short videos inside the
  // same player, which is flagged with the "ad-showing" class while the show
  // waits. Jumping the ad video to its end makes the player move on to the
  // next ad, then back to the show. If that ever stops working, fall back to
  // muting and playing the ads at 16x.
  const MAX_JUMPS_PER_BREAK = 15;

  function adCheck() {
    const p = document.querySelector("#movie_player");
    const adShowing = !!(p && p.classList.contains("ad-showing"));
    const v = mainVideo();
    const ad = state.ad;
    const now = Date.now();

    if (adShowing && v && settings.enabled && settings.skipOnDemandAds) {
      if (!ad.active) {
        state.ad = { active: true, count: 0, saved: 0, lastJumpAt: 0, fallback: false, prevMuted: v.muted, prevRate: v.playbackRate, startedAt: now };
        log("on-demand ad break started");
      }
      const a = state.ad;
      const d = v.duration;
      if (!Number.isFinite(d) || d <= 1 || v.currentTime >= d - 1) return;
      const r = a.recent || [];
      const last4 = r.slice(-4);
      const restarting = last4.length === 4 && last4.every((x) => x.d === last4[0].d) && last4[3].at - last4[0].at < 4000;
      if (!a.fallback && (a.count >= MAX_JUMPS_PER_BREAK || restarting)) {
        a.fallback = true;
        log("jumping isn't ending the ads; switching to mute + 16x");
      }
      if (a.fallback) {
        if (!v.muted) v.muted = true;
        if (v.playbackRate !== 16) {
          try { v.playbackRate = 16; } catch (_) { /* some players cap the rate */ }
        }
        return;
      }
      if (now - a.lastJumpAt < 700) return;
      a.saved += d - v.currentTime;
      a.count++;
      a.lastJumpAt = now;
      (a.recent = a.recent || []).push({ at: now, d: Math.round(d) });
      log("jumping on-demand ad to its end (" + Math.round(d) + "s ad)");
      v.currentTime = Math.max(0, d - 0.05);
      return;
    }

    if (!adShowing && ad.active) {
      if (ad.fallback && v) {
        v.muted = ad.prevMuted;
        try { v.playbackRate = ad.prevRate || 1; } catch (_) { /* ignore */ }
      }
      const seconds = ad.fallback ? (now - ad.startedAt) / 1000 * 15 / 16 : ad.saved;
      const n = ad.fallback ? 0 : ad.count;
      if (n > 0 || ad.fallback) {
        bumpStats({ adsSkipped: Math.max(1, n), secondsSaved: Math.max(0, seconds) });
        showNotice({ summary: true, message: ad.fallback
          ? "Fast-forwarded the ad break (muted, 16× speed)."
          : "Skipped " + n + " ad" + (n === 1 ? "" : "s") + " (" + S.formatTime(seconds) + ")." });
      }
      log("on-demand ad break over", ad);
      state.ad = { active: false };
    }
  }

  // ---------- marking ----------

  // Playback time right now (time messages arrive every 250 ms).
  function timeNow() {
    if (!Number.isFinite(state.time)) return NaN;
    if (state.paused !== false) return state.time;
    return state.time + ((Date.now() - state.timeAt) / 1000) * (state.playbackRate || 1);
  }

  function startOrEndMark() {
    const t = timeNow();
    if (!state.videoId || !Number.isFinite(t)) return;
    if (!state.mark) {
      state.mark = { phase: "started", start: Math.round(t * 10) / 10 };
    } else if (state.mark.phase === "started") {
      state.mark.end = Math.round(t * 10) / 10;
      state.mark.phase = "review";
      validateMark();
      hideNotice();
      const v = mainVideo();
      if (v && !v.paused) v.pause();
    }
    render();
  }

  function validateMark() {
    const m = state.mark;
    if (m) m.error = S.checkMark(m.start, m.end, duration());
  }

  function nudge(which, delta) {
    const m = state.mark;
    if (!m) return;
    m[which] = Math.max(0, Math.round((m[which] + delta) * 10) / 10);
    if (which === "start") m.startExact = false;
    validateMark();
    render();
  }

  function previewAt(t) {
    toPage({ type: "seek", time: Math.max(0, t) });
    const v = mainVideo();
    if (v && v.paused) v.play().catch(() => {});
  }

  function cancelMark() {
    state.mark = null;
    render();
  }

  async function submitMark() {
    const m = state.mark;
    if (!m || m.error || m.submitting) return;
    m.submitting = true;
    render();
    const vid = state.videoId;
    let res;
    if (state.communityStatus === "not-configured") {
      const list = localSegments[vid] || (localSegments[vid] = []);
      list.push({
        start: m.start,
        end: m.end,
        duration: duration(),
        title: state.info ? state.info.title : "",
        channelId: state.info ? state.info.channelId : "",
        savedAt: new Date().toISOString()
      });
      if (!PRIVATE) await browser.storage.local.set({ localSegments });
      res = { ok: true, local: true };
    } else {
      try {
        res = await browser.runtime.sendMessage({
          type: "submit",
          videoId: vid,
          start: m.start,
          end: m.end,
          duration: duration(),
          channelId: state.info ? state.info.channelId : ""
        });
      } catch (e) {
        res = { ok: false, error: String(e) };
      }
    }
    if (res && res.ok) {
      bumpStats({ submissions: 1 });
      state.mark = null;
      showNotice({ message: res.local ? "Saved on this computer. (Community sharing isn't set up yet.)" : "Thanks! Your commercial break was shared." });
      loadCommunity();
    } else {
      m.submitting = false;
      m.error = friendlyError(res && res.error);
      render();
    }
  }

  function friendlyError(code) {
    if (!code) return "Something went wrong. Please try again.";
    if (/rate_limited/.test(code)) return "You've shared a lot recently. Please try again in a while.";
    if (/banned/.test(code)) return "Submissions from this browser are blocked.";
    if (/too_many/.test(code)) return "This recording already has a lot of marked breaks.";
    if (/invalid/.test(code)) return "The server didn't accept those times. Please double-check them.";
    return "Couldn't reach the CommercialBlock server. Please try again.";
  }

  async function vote(ids, value) {
    const targets = ids.filter((id) => !String(id).startsWith("yt-") && !String(id).startsWith("local-"));
    for (const id of targets) {
      if (myVotes[id] === value) continue;
      try {
        const res = await browser.runtime.sendMessage({ type: "vote", segmentId: id, value });
        if (res && res.ok) {
          myVotes[id] = value;
          bumpStats({ votes: 1 });
        } else {
          log("vote failed", res && res.error);
        }
      } catch (e) {
        log("vote failed", e);
      }
    }
    if (!PRIVATE) browser.storage.local.set({ myVotes }).catch(() => {});
  }

  // ---------- UI ----------

  let root, bar, markBtn, markSub, cancelBtn, review, notice, noticeTimer;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function buildUI() {
    root = el("div", "cb-root");
    root.id = "commercialblock-root";

    bar = el("div", "cb-bar");
    markBtn = el("button", "cb-btn cb-mark");
    markBtn.type = "button";
    markBtn.title = "Mark a commercial break (shortcut: ;)";
    markBtn.addEventListener("click", (e) => { e.stopPropagation(); startOrEndMark(); });
    markSub = el("span", "cb-mark-sub");
    cancelBtn = el("button", "cb-btn cb-icon", "✕");
    cancelBtn.type = "button";
    cancelBtn.title = "Cancel marking (Esc)";
    cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); cancelMark(); });
    bar.append(markBtn, markSub, cancelBtn);

    review = el("div", "cb-review");
    notice = el("div", "cb-notice");
    notice.addEventListener("mouseenter", () => clearTimeout(noticeTimer));
    notice.addEventListener("mouseleave", () => scheduleNoticeHide(3000));

    // Keep YouTube TV from treating clicks on our UI as player clicks.
    for (const n of [bar, review, notice]) {
      n.addEventListener("mousedown", (e) => e.stopPropagation());
      n.addEventListener("pointerdown", (e) => e.stopPropagation());
    }
    root.append(bar, review, notice);
  }

  function mainVideo() {
    return document.querySelector("#movie_player video, .html5-video-container video");
  }

  function playerRect() {
    const p = document.querySelector("#movie_player");
    let r = p && p.getBoundingClientRect();
    if (!r || r.width < 200 || r.height < 100) {
      const v = mainVideo();
      r = v && v.getBoundingClientRect();
    }
    return r && r.width >= 200 && r.height >= 100 ? r : null;
  }

  function ensureAttached() {
    const host = document.fullscreenElement || document.body;
    if (host && root.parentNode !== host) host.appendChild(root);
  }

  function render() {
    if (!root) return;
    ensureAttached();
    const rect = state.videoId ? playerRect() : null;
    if (!rect) {
      root.style.display = "none";
      return;
    }
    root.style.display = "block";
    root.style.left = rect.left + "px";
    root.style.top = rect.top + "px";
    root.style.width = rect.width + "px";
    root.style.height = rect.height + "px";

    const m = state.mark;
    const active = Date.now() - state.lastMouse < 3000;
    bar.classList.toggle("cb-visible", !!m || active);

    if (!m) {
      markBtn.textContent = "⏺ Mark commercial";
      markSub.textContent = "";
      cancelBtn.style.display = "none";
    } else if (m.phase === "started") {
      markBtn.textContent = "⏹ Commercial ends here";
      markSub.textContent = "started at " + S.formatTime(m.start);
      cancelBtn.style.display = "";
    } else {
      markBtn.textContent = "Reviewing…";
      markSub.textContent = "";
      cancelBtn.style.display = "";
    }
    markBtn.disabled = !!(m && m.phase === "review");

    renderReview();
    renderMarkers();
  }

  function renderReview() {
    const m = state.mark;
    if (!m || m.phase !== "review") {
      review.classList.remove("cb-visible");
      review.replaceChildren();
      review.dataset.key = "";
      return;
    }
    const key = [m.start, m.end, m.error, m.submitting, m.startExact, state.communityStatus].join("|");
    if (review.dataset.key === key) return;
    review.dataset.key = key;

    const title = el("div", "cb-review-title", "Mark this commercial break");
    const row = (label, which) => {
      const r = el("div", "cb-row");
      const mk = (txt, delta) => {
        const b = el("button", "cb-btn cb-small cb-nudge", txt);
        b.title = "Move the " + which + " " + Math.abs(delta) + (Math.abs(delta) === 1 ? " second " : " seconds ") + (delta < 0 ? "earlier" : "later");
        b.addEventListener("click", () => nudge(which, delta));
        return b;
      };
      const watch = el("button", "cb-btn cb-small", "▶");
      watch.title = which === "start" ? "Play from just before the start" : "Play from just before the end";
      watch.addEventListener("click", () => previewAt(m[which] - 3));
      r.append(el("span", "cb-label", label), mk("−5", -5), mk("−1", -1),
        el("span", "cb-time", S.formatTime(m[which])), mk("+1", 1), mk("+5", 5), watch);
      return r;
    };
    const len = el("div", "cb-len", "Length: " + S.formatTime(Math.max(0, m.end - m.start)));
    const snap = S.snapSuggestion(m.start, m.end, m.startExact);
    let snapRow = null;
    if (snap) {
      snapRow = el("div", "cb-snap");
      const btn = el("button", "cb-btn cb-small", "Make it exactly " + S.formatTime(snap.target));
      btn.title = "Commercials run in 15-second blocks, so breaks are usually an exact length. This moves the " +
        (snap.start !== m.start ? "start" : "end") + " to " + S.formatTime(snap.start !== m.start ? snap.start : snap.end) + ".";
      btn.addEventListener("click", () => {
        m.start = snap.start;
        m.end = snap.end;
        validateMark();
        render();
      });
      snapRow.append(btn, el("span", "cb-snap-why", "Breaks are usually an exact length"));
    }
    const err = el("div", "cb-error", m.error || "");
    const actions = el("div", "cb-actions");
    const submit = el("button", "cb-btn cb-primary",
      m.submitting ? "Sending…" : state.communityStatus === "not-configured" ? "Save" : "Share with community");
    submit.disabled = !!(m.error || m.submitting);
    submit.addEventListener("click", submitMark);
    const cancel = el("button", "cb-btn", "Cancel");
    cancel.addEventListener("click", cancelMark);
    actions.append(submit, cancel);
    const hint = el("div", "cb-hint", m.fromYouTube
      ? "The start is where YouTube TV's marker was, but commercials may have begun earlier. Press ▶ next to Start to check, and move it back if needed."
      : "Tip: press ▶ to make sure the show isn't cut off.");
    if (m.fromYouTube) hint.classList.add("cb-hint-warn");
    review.replaceChildren(...[title, row("Start", "start"), row("End", "end"), len, snapRow, err, actions, hint].filter(Boolean));
    review.classList.add("cb-visible");
  }

  function showNotice(opts) {
    if (!settings.showNotice && (opts.summary || (!opts.failed && !opts.message))) return;
    clearTimeout(noticeTimer);
    const parts = [];
    if (opts.failed) {
      parts.push(el("span", "cb-notice-text", "YouTube TV didn't allow skipping this commercial."));
    } else if (opts.message) {
      parts.push(el("span", "cb-notice-text", opts.message));
    } else {
      const r = opts.range;
      const src = r.sources.includes("community") && r.sources.includes("youtube")
        ? "YouTube TV + community"
        : r.sources.includes("community") ? "community" : "YouTube TV";
      parts.push(el("span", "cb-notice-text", "Skipped commercial (" + S.formatTime(opts.saved) + ") · " + src));
      const undo = el("button", "cb-btn cb-small", "Undo");
      undo.addEventListener("click", () => {
        state.ignored.add(r.key);
        toPage({ type: "seek", time: Math.max(0, opts.from - 0.5) });
        hideNotice();
      });
      parts.push(undo);
      if (!r.sources.includes("community")) {
        // YouTube TV's list often covers only the first minute of a longer
        // break. Let the viewer extend it to where the show really returns.
        const more = el("button", "cb-btn cb-small cb-primary", "Still ads?");
        more.title = "The commercials kept going. Click, then press ; (or the button at the top right) when the show comes back.";
        more.addEventListener("click", () => {
          // YouTube TV's marker can sit anywhere inside the real break, so the
          // start is only a first guess; the review panel asks to check it.
          state.mark = { phase: "started", start: Math.round(r.start * 10) / 10, fromYouTube: true };
          state.lastMouse = Date.now();
          notice.replaceChildren(el("span", "cb-notice-text", "OK. Press ; or click “Commercial ends here” when the show comes back."));
          scheduleNoticeHide(8000);
          render();
        });
        parts.push(more);
      }
      const communityIds = r.ids.filter((id) => !String(id).startsWith("yt-") && !String(id).startsWith("local-"));
      if (communityIds.length) {
        const up = el("button", "cb-btn cb-small", "👍");
        const down = el("button", "cb-btn cb-small", "👎");
        up.title = "This was a commercial";
        down.title = "This was NOT a commercial (or the times are wrong)";
        up.addEventListener("click", () => { vote(communityIds, 1); up.disabled = down.disabled = true; up.textContent = "👍 Thanks"; scheduleNoticeHide(1500); });
        down.addEventListener("click", () => {
          vote(communityIds, -1);
          up.disabled = down.disabled = true;
          down.textContent = "👎 Thanks";
          state.ignored.add(r.key);
          toPage({ type: "seek", time: Math.max(0, opts.from - 0.5) });
          scheduleNoticeHide(1500);
        });
        parts.push(up, down);
      }
    }
    notice.replaceChildren(...parts);
    notice.classList.add("cb-visible");
    const youtubeOnly = opts.range && !opts.range.sources.includes("community");
    scheduleNoticeHide(opts.failed ? 8000 : youtubeOnly ? 15000 : 6000);
  }

  function scheduleNoticeHide(ms) {
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, ms);
  }

  function hideNotice() {
    notice.classList.remove("cb-visible");
  }

  function renderMarkers() {
    const dur = duration();
    const timelines = document.querySelectorAll(".ytu-ss-timeline");
    const m = state.mark;
    const pending = m ? [m.start, m.phase === "review" ? m.end : state.time] : null;
    const key = [settings.showMarkers, settings.useYouTube, dur, state.ranges.map((r) => r.key + ":" + r.start + "-" + r.end).join(","), pending && pending.map((x) => Math.round(x)).join("-")].join("|");
    timelines.forEach((tl) => {
      let box = tl.querySelector(":scope > .cb-markers");
      if (!box) {
        box = el("div", "cb-markers");
        if (getComputedStyle(tl).position === "static") tl.style.position = "relative";
        tl.appendChild(box);
      }
      if (box.dataset.key === key) return;
      box.dataset.key = key;
      box.replaceChildren();
      if (!settings.showMarkers || !dur) return;
      const add = (start, end, cls) => {
        const s = el("div", "cb-marker " + cls);
        s.style.left = (Math.max(0, start) / dur) * 100 + "%";
        s.style.width = (Math.max(0.2, end - start) / dur) * 100 + "%";
        box.appendChild(s);
      };
      // Green: community breaks (full height). Yellow: YouTube TV's own breaks,
      // drawn as a thinner stripe on top so both stay visible when they overlap.
      for (const r of state.ranges) {
        if (r.sources.includes("community")) add(r.start, r.end, "cb-community");
      }
      if (settings.useYouTube && state.info) {
        const overlapsGreen = (p) => state.ranges.some((r) => r.sources.includes("community") && p.start < r.end && p.end > r.start);
        for (const p of state.info.placements) add(p.start, p.end, overlapsGreen(p) ? "cb-youtube cb-youtube-thin" : "cb-youtube");
      }
      if (pending && pending[1] > pending[0]) add(pending[0], pending[1], "cb-pending");
    });
  }

  // ---------- input ----------

  document.addEventListener("mousemove", (e) => {
    const r = root && root.style.display !== "none" ? root.getBoundingClientRect() : null;
    if (r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      state.lastMouse = Date.now();
    }
  }, { passive: true });

  document.addEventListener("keydown", (e) => {
    if (!state.videoId) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === ";" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      startOrEndMark();
    } else if (e.key === "Escape" && state.mark) {
      cancelMark();
    }
  }, true);

  document.addEventListener("fullscreenchange", () => render());
  window.addEventListener("resize", () => render(), { passive: true });

  // ---------- popup + settings ----------

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "status") {
      return Promise.resolve({
        videoId: state.videoId,
        title: state.info ? state.info.title : "",
        youtubeBreaks: state.info ? state.info.placements.length : 0,
        youtubeList: state.info ? state.info.placements : [],
        communityBreaks: state.communityPicked.length,
        communityStatus: state.communityStatus,
        ranges: state.ranges.map((r) => ({ start: r.start, end: r.end, sources: r.sources })),
        fallback: state.info ? state.info.fallback : false
      });
    }
    if (msg && msg.type === "refresh") {
      loadCommunity(true);
      return Promise.resolve(true);
    }
    return undefined;
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) {
      const before = settings;
      settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      if (before.useCommunity !== settings.useCommunity) loadCommunity();
      else rebuild();
    }
    if (changes.localSegments) {
      localSegments = changes.localSegments.newValue || {};
      loadCommunity();
    }
  });

  // ---------- start ----------

  browser.storage.local.get(["settings", "myVotes", "localSegments"]).then((data) => {
    settings = { ...DEFAULTS, ...(data.settings || {}) };
    myVotes = data.myVotes || {};
    localSegments = data.localSegments || {};
  }).catch(() => {}).finally(() => {
    buildUI();
    toPage({ type: "hello" });
    setInterval(render, 1000);
    setInterval(adCheck, 250);
  });
})();
