// CommercialBlock break logic (pure functions, no browser APIs, unit-tested).
(function (root) {
  "use strict";

  const HIDE_SCORE = -2; // community breaks at or below this score are ignored
  const MIN_LEN = 4; // seconds
  const MAX_LEN = 900; // seconds (15 minutes)
  const END_GUARD = 0.75; // don't skip if less than this remains in a break

  function overlap(a, b) {
    return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  }

  function validSegment(s, duration) {
    if (!s || !Number.isFinite(s.start) || !Number.isFinite(s.end)) return false;
    if (s.start < 0 || s.end - s.start < MIN_LEN || s.end - s.start > MAX_LEN) return false;
    if (duration && s.start > duration + 1) return false;
    return true;
  }

  // Community breaks: drop low-score ones and, when two breaks describe the
  // same commercial (heavy overlap), keep the better-voted one.
  function pickCommunity(list, duration) {
    const ok = (list || [])
      .filter((s) => validSegment(s, duration) && (s.votes || 0) > HIDE_SCORE)
      .slice()
      .sort((a, b) => (b.votes || 0) - (a.votes || 0) || a.start - b.start);
    const kept = [];
    for (const s of ok) {
      const dup = kept.some((k) => overlap(k, s) >= 0.5 * Math.min(k.end - k.start, s.end - s.start));
      if (!dup) kept.push(s);
    }
    return kept.sort((a, b) => a.start - b.start);
  }

  // Combine YouTube TV breaks and community breaks into skip ranges.
  // Touching or overlapping ranges (gap < 1.5s) merge so one skip clears a
  // whole commercial block.
  function buildSkipRanges(youtube, community, duration) {
    const all = [];
    (youtube || []).forEach((s, i) => {
      if (validSegment(s, duration)) all.push({ start: s.start, end: s.end, sources: ["youtube"], ids: ["yt-" + i] });
    });
    (community || []).forEach((s) => {
      all.push({ start: s.start, end: s.end, sources: ["community"], ids: [s.id] });
    });
    all.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const s of all) {
      const last = merged[merged.length - 1];
      if (last && s.start <= last.end + 1.5) {
        last.end = Math.max(last.end, s.end);
        s.sources.forEach((x) => { if (!last.sources.includes(x)) last.sources.push(x); });
        last.ids.push(...s.ids);
      } else {
        merged.push({ start: s.start, end: s.end, sources: s.sources.slice(), ids: s.ids.slice() });
      }
    }
    if (duration) {
      merged.forEach((m) => { m.end = Math.min(m.end, duration); });
    }
    merged.forEach((m) => { m.key = m.ids.join("+"); });
    return merged.filter((m) => m.end - m.start >= 1);
  }

  // Which range (if any) should be skipped at this playback time?
  function findSkip(time, ranges, ignoredKeys) {
    if (!Number.isFinite(time)) return null;
    for (const r of ranges || []) {
      if (ignoredKeys && ignoredKeys.has(r.key)) continue;
      if (time >= r.start && time < r.end - END_GUARD) return r;
    }
    return null;
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
  }

  // Validate a user's mark before submitting.
  function checkMark(start, end, duration) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "Missing start or end time.";
    if (end <= start) return "The end has to be after the start.";
    if (end - start < MIN_LEN) return "That's shorter than " + MIN_LEN + " seconds. Commercial breaks are usually longer.";
    if (end - start > MAX_LEN) return "That's longer than 15 minutes. Please mark one commercial break at a time.";
    if (duration && end > duration + 1) return "The end is past the end of the recording.";
    return null;
  }

  // Commercials are sold in 15/30-second slots, so real breaks are usually an
  // exact multiple of 15 seconds. Marks drift by a second or two of reaction
  // time: you notice an ad only after it starts (start too late -> too short)
  // and press "end" a moment after the show returns (end too late -> too long).
  // startExact: the start came from YouTube TV's data, so only move the end.
  function snapSuggestion(start, end, startExact) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const len = end - start;
    const target = Math.round(len / 15) * 15;
    const diff = target - len;
    if (target < 15 || Math.abs(diff) < 0.3 || Math.abs(diff) > 5) return null;
    let s = start;
    let e = end;
    if (startExact || diff < 0) e = start + target; // too long: trim the late end
    else s = Math.max(0, end - target); // too short: the start was pressed late
    if (s === 0 && e - s !== target) e = s + target;
    return { start: Math.round(s * 10) / 10, end: Math.round(e * 10) / 10, target };
  }

  const api = { snapSuggestion, pickCommunity, buildSkipRanges, findSkip, formatTime, checkMark, overlap, HIDE_SCORE, MIN_LEN, MAX_LEN };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CBSegments = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
