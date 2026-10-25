const test = require("node:test");
const assert = require("node:assert");
const S = require("../extension/content/segments.js");

test("YouTube TV placements become skip ranges", () => {
  const r = S.buildSkipRanges([{ start: 140.773, end: 200.799 }, { start: 791.29, end: 851.316 }], [], 1865);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[0].sources, ["youtube"]);
});

test("adjacent YouTube + community ranges merge into one skip", () => {
  const r = S.buildSkipRanges([{ start: 140, end: 200 }], [{ id: "a", start: 200.5, end: 260, votes: 0 }], 1865);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].start, 140);
  assert.strictEqual(r[0].end, 260);
  assert.deepStrictEqual(r[0].sources.sort(), ["community", "youtube"]);
});

test("low-voted community breaks are dropped", () => {
  const c = S.pickCommunity([{ id: "a", start: 10, end: 70, votes: -2 }, { id: "b", start: 100, end: 160, votes: -1 }], 1865);
  assert.deepStrictEqual(c.map((x) => x.id), ["b"]);
});

test("duplicate community breaks keep the best-voted one", () => {
  const c = S.pickCommunity([
    { id: "low", start: 100, end: 160, votes: 0 },
    { id: "high", start: 102, end: 161, votes: 3 },
    { id: "other", start: 500, end: 560, votes: 0 }
  ], 1865);
  assert.deepStrictEqual(c.map((x) => x.id), ["high", "other"]);
});

test("findSkip only fires inside a range and respects ignored ranges", () => {
  const r = S.buildSkipRanges([{ start: 100, end: 160 }], [], 1000);
  assert.strictEqual(S.findSkip(99.9, r), null);
  assert.ok(S.findSkip(100, r));
  assert.ok(S.findSkip(150, r));
  assert.strictEqual(S.findSkip(159.5, r), null); // too close to the end to bother
  assert.strictEqual(S.findSkip(150, r, new Set([r[0].key])), null);
  assert.strictEqual(S.findSkip(NaN, r), null);
});

test("ranges are clamped to the recording length; invalid ones ignored", () => {
  const r = S.buildSkipRanges([{ start: 950, end: 1100 }, { start: 5, end: 6 }, { start: NaN, end: 9 }], [], 1000);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].end, 1000);
});

test("checkMark validation", () => {
  assert.strictEqual(S.checkMark(10, 70, 1000), null);
  assert.match(S.checkMark(70, 10, 1000), /after the start/);
  assert.match(S.checkMark(10, 12, 1000), /shorter/);
  assert.match(S.checkMark(10, 2000, 3000), /longer/);
  assert.match(S.checkMark(950, 1010, 1000), /past the end/);
});

test("snap: your real marks become exact 2:00 / 3:00 / 2:30 by moving the start earlier", () => {
  assert.deepStrictEqual(S.snapSuggestion(61.4, 179.7), { start: 59.7, end: 179.7, target: 120 });
  assert.deepStrictEqual(S.snapSuggestion(792.6, 970.6), { start: 790.6, end: 970.6, target: 180 });
  assert.deepStrictEqual(S.snapSuggestion(1322.5, 1470.5), { start: 1320.5, end: 1470.5, target: 150 });
});

test("snap: too long trims the end; exact (YouTube) start only moves the end", () => {
  assert.deepStrictEqual(S.snapSuggestion(100, 222), { start: 100, end: 220, target: 120 });
  assert.deepStrictEqual(S.snapSuggestion(791.3, 969.0, true), { start: 791.3, end: 971.3, target: 180 });
});

test("snap: no suggestion when already exact, far off, or tiny", () => {
  assert.strictEqual(S.snapSuggestion(100, 220), null);
  assert.strictEqual(S.snapSuggestion(100, 212.5), null); // 7.5s from any 15s multiple: not a reaction-time error
  assert.strictEqual(S.snapSuggestion(100, 108), null);
});

test("formatTime", () => {
  assert.strictEqual(S.formatTime(0), "0:00");
  assert.strictEqual(S.formatTime(61.4), "1:01");
  assert.strictEqual(S.formatTime(3725), "1:02:05");
});
