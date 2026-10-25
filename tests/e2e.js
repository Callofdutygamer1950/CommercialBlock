// End-to-end test: real extension scripts running on a simulated YouTube TV page.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PW_MODULE || "playwright");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const OUT = process.env.OUT_DIR || __dirname;

const stub = `
(() => {
  const store = {};
  const listeners = { storage: [], message: [] };
  window.__bg = { submits: [], votes: [], segments: [{ id: "seg-1", video_id: "33rnEV3E4mA", start: 600, end: 660, votes: 1 }] };
  window.browser = {
    storage: {
      local: {
        get: async (keys) => { const ks = typeof keys === "string" ? [keys] : keys; const o = {}; ks.forEach(k => { if (k in store) o[k] = JSON.parse(JSON.stringify(store[k])); }); return o; },
        set: async (obj) => { const ch = {}; for (const k in obj) { ch[k] = { oldValue: store[k], newValue: obj[k] }; store[k] = JSON.parse(JSON.stringify(obj[k])); } listeners.storage.forEach(f => f(ch, "local")); }
      },
      onChanged: { addListener: (f) => listeners.storage.push(f) }
    },
    runtime: {
      onMessage: { addListener: (f) => listeners.message.push(f) },
      sendMessage: async (m) => {
        if (m.type === "getSegments") return { ok: true, segments: __bg.segments.filter(s => s.video_id === m.videoId).map(s => ({ id: s.id, start: s.start, end: s.end, votes: s.votes })) };
        if (m.type === "submit") { __bg.submits.push(m); return { ok: true, id: "new-1" }; }
        if (m.type === "vote") { __bg.votes.push(m); return { ok: true, score: 0 }; }
        return { ok: false };
      }
    }
  };
  window.__sendToContent = (m) => Promise.all(listeners.message.map(f => f(m)));
})();`;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : ""));
}

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/watch/") || req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      return res.end(fs.readFileSync(path.join(__dirname, "fake-player.html")));
    }
    res.statusCode = 404;
    res.end();
  }).listen(8123);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.addInitScript(stub);
  await page.goto("http://localhost:8123/watch/33rnEV3E4mA");
  await page.addScriptTag({ path: path.join(EXT, "content/page-bridge.js") });
  await page.addStyleTag({ path: path.join(EXT, "content/content.css") });
  await page.addScriptTag({ path: path.join(EXT, "content/segments.js") });
  await page.addScriptTag({ path: path.join(EXT, "content/content.js") });
  await page.waitForTimeout(1500);

  const status = (await page.evaluate(() => __sendToContent({ type: "status" })))[0];
  check("detects recording + YouTube TV break list", status.videoId === "33rnEV3E4mA" && status.youtubeBreaks === 1, status);
  check("loads community breaks", status.communityBreaks === 1);
  check("ignores the non-timed (START) placement", status.ranges.length === 2, status.ranges);

  const markers = await page.$$eval(".ytu-ss-timeline .cb-marker", (els) => els.map((e) => e.className + " " + e.style.left));
  check("draws 2 markers on the progress bar", markers.length === 2, markers);

  // 1) Automatic YouTube TV break skip
  await page.evaluate(() => { fake.t = 139; fake.playing = true; });
  await page.waitForTimeout(3000);
  let t = await page.evaluate(() => fake.t);
  check("skips the YouTube TV break (140.8 → 200.8)", t > 200.7 && t < 203, t);
  let noticeText = await page.textContent(".cb-notice");
  check("shows skip notice naming YouTube TV", /Skipped commercial/.test(noticeText) && /YouTube TV/.test(noticeText), noticeText);
  await page.screenshot({ path: path.join(OUT, "shot-skip-notice.png") });

  // 2) Undo returns to the break and does not skip it again
  await page.click(".cb-notice button:has-text('Undo')");
  await page.waitForTimeout(1500);
  t = await page.evaluate(() => fake.t);
  check("Undo goes back into the break and stays there", t > 140 && t < 145, t);

  // 3) Community break skip + downvote
  await page.evaluate(() => { fake.t = 599; });
  await page.waitForTimeout(2500);
  t = await page.evaluate(() => fake.t);
  check("skips the community break (600 → 660)", t > 659.9 && t < 663, t);
  noticeText = await page.textContent(".cb-notice");
  check("community notice offers voting", /community/.test(noticeText) && /👎/.test(noticeText), noticeText);
  await page.click(".cb-notice button:has-text('👎')");
  await page.waitForTimeout(800);
  const votes = await page.evaluate(() => __bg.votes);
  check("downvote sent for seg-1 and jumps back", votes.length === 1 && votes[0].segmentId === "seg-1" && votes[0].value === -1, votes);

  // 4) Marking a new break with the ; key
  await page.evaluate(() => { fake.t = 1000; fake.playing = true; fake.rate = 1; });
  await page.waitForTimeout(400); // let the jump settle (a real user can't press ; that fast after seeking)
  await page.evaluate(() => { fake.t = 1000; });
  await page.mouse.move(500, 300);
  await page.keyboard.press(";");
  await page.evaluate(() => { fake.rate = 10; });
  await page.waitForTimeout(400);
  const barText = await page.textContent(".cb-bar");
  check("; starts a mark", /ends here/.test(barText), barText);
  await page.waitForTimeout(4500); // ~45s of fake time
  await page.keyboard.press(";");
  await page.waitForTimeout(400);
  const paused = await page.evaluate(() => !fake.playing);
  const reviewVisible = await page.isVisible(".cb-review");
  check("second ; opens review panel and pauses", reviewVisible && paused);
  await page.screenshot({ path: path.join(OUT, "shot-review.png") });
  await page.locator(".cb-review .cb-row").first().locator("button", { hasText: "+1" }).click();
  await page.click(".cb-review button:has-text('Share with community')");
  await page.waitForTimeout(600);
  const subs = await page.evaluate(() => __bg.submits);
  const s0 = subs[0] || {};
  check("submits the marked break with nudged start", subs.length === 1 && Math.abs(s0.start - 1001) < 0.6 && s0.end - s0.start > 30 && s0.videoId === "33rnEV3E4mA", s0);
  noticeText = await page.textContent(".cb-notice");
  check("thank-you notice after sharing", /Thanks/.test(noticeText), noticeText);

  // 5) Too-short mark is rejected
  await page.evaluate(() => { fake.rate = 1; fake.playing = true; });
  await page.keyboard.press(";");
  await page.waitForTimeout(500);
  await page.keyboard.press(";");
  await page.waitForTimeout(300);
  const err = await page.textContent(".cb-review .cb-error");
  const disabled = await page.$eval(".cb-review .cb-primary", (b) => b.disabled);
  check("too-short break shows an error and can't be submitted", /shorter/.test(err) && disabled, err);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Esc cancels marking", !(await page.isVisible(".cb-review")));

  // 6) Clicks YouTube TV's own Skip ad button when it appears
  await page.evaluate(() => { document.querySelector("button.skip-ad-button").style.display = "block"; });
  await page.waitForTimeout(1500);
  const adClicks = await page.evaluate(() => fake.adClicks);
  check("presses YouTube TV's Skip ad button", adClicks >= 1, adClicks);
  await page.evaluate(() => { document.querySelector("button.skip-ad-button").style.display = "none"; });

  // 7) Seek refused by the player (e.g. on-demand version): gives up after 2 tries, no loop
  await page.evaluate(() => { fake.allowSeeking = false; fake.seeks = []; fake.t = 139; fake.rate = 1; fake.playing = true; });
  // the YouTube break was "undone" earlier in this session, so reload state by navigating segments: use community-free range
  await page.evaluate(() => __bg.segments.push({ id: "seg-2", video_id: "33rnEV3E4mA", start: 1500, end: 1560, votes: 2 }));
  await page.evaluate(() => __sendToContent({ type: "refresh" }));
  await page.evaluate(() => { fake.t = 1499.5; });
  await page.waitForTimeout(7000);
  const seeks = await page.evaluate(() => fake.seeks.length);
  noticeText = await page.textContent(".cb-notice");
  check("stops retrying when YouTube TV blocks skipping", seeks <= 2 && /didn't allow/.test(noticeText), { seeks, noticeText });

  // 8) Turning the extension off stops skipping
  await page.evaluate(() => browser.storage.local.set({ settings: { enabled: false } }));
  await page.evaluate(() => { fake.allowSeeking = true; fake.seeks = []; __bg.segments.push({ id: "seg-3", video_id: "33rnEV3E4mA", start: 1700, end: 1760, votes: 2 }); });
  await page.evaluate(() => __sendToContent({ type: "refresh" }));
  await page.evaluate(() => { fake.t = 1699.5; });
  await page.waitForTimeout(2500);
  check("does nothing when switched off", (await page.evaluate(() => fake.seeks.length)) === 0);

  // 9) Fresh page: YouTube TV break covers only the first minute; "Still ads?" extends it, snap fixes the length
  const page2 = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  page2.on("pageerror", (e) => errors.push(String(e)));
  await page2.addInitScript(stub);
  await page2.goto("http://localhost:8123/watch/33rnEV3E4mA");
  await page2.addScriptTag({ path: path.join(EXT, "content/page-bridge.js") });
  await page2.addStyleTag({ path: path.join(EXT, "content/content.css") });
  await page2.addScriptTag({ path: path.join(EXT, "content/segments.js") });
  await page2.addScriptTag({ path: path.join(EXT, "content/content.js") });
  await page2.waitForTimeout(1500);
  await page2.evaluate(() => { fake.t = 139; fake.playing = true; });
  await page2.waitForTimeout(3000);
  noticeText = await page2.textContent(".cb-notice");
  check("YouTube-only skip offers 'Still ads?'", /Still ads\?/.test(noticeText), noticeText);
  await page2.click(".cb-notice button:has-text('Still ads?')");
  await page2.waitForTimeout(300);
  const bar2 = await page2.textContent(".cb-bar");
  check("'Still ads?' starts a mark at the YouTube break's start (2:21)", /ends here/.test(bar2) && /2:21/.test(bar2), bar2);
  await page2.evaluate(() => { fake.t = 322.3; });
  await page2.waitForTimeout(400);
  await page2.keyboard.press(";");
  await page2.waitForTimeout(400);
  const warn = await page2.textContent(".cb-review .cb-hint");
  check("review warns the start may be earlier than YouTube's marker", /may have begun earlier/.test(warn), warn);
  await page2.locator(".cb-review .cb-row").first().locator("button", { hasText: "−5" }).click();
  await page2.waitForTimeout(200);
  const startTxt = await page2.locator(".cb-review .cb-row").first().locator(".cb-time").textContent();
  check("−5 moves the start back 5 seconds (2:21 → 2:16)", startTxt === "2:16", startTxt);
  await page2.locator(".cb-review .cb-row").first().locator("button", { hasText: "+5" }).click();
  await page2.keyboard.press("Escape");
  await page2.evaluate(() => { fake.t = 139; fake.playing = true; });
  await page2.waitForTimeout(3000);
  await page2.click(".cb-notice button:has-text('Still ads?')");
  await page2.waitForTimeout(300);
  // the real break is 3:00 (140.8 → 320.8); viewer reacts ~1.5s late
  await page2.evaluate(() => { fake.t = 322.3; });
  await page2.waitForTimeout(400);
  await page2.keyboard.press(";");
  await page2.waitForTimeout(400);
  const snapBtn = page2.locator(".cb-review button", { hasText: "Make it exactly 3:00" });
  check("review offers 'Make it exactly 3:00'", (await snapBtn.count()) === 1);
  await page2.screenshot({ path: path.join(OUT, "shot-snap.png") });
  await snapBtn.click();
  await page2.waitForTimeout(200);
  check("snap removes the button once exact", (await page2.locator(".cb-snap").count()) === 0);
  await page2.click(".cb-review button:has-text('Share with community')");
  await page2.waitForTimeout(600);
  const sub2 = (await page2.evaluate(() => __bg.submits))[0] || {};
  check("shares the full break 140.8 → 320.8 (too long, so the late end is trimmed)", Math.abs(sub2.start - 140.8) < 0.05 && Math.abs(sub2.end - 320.8) < 0.05, sub2);
  await page2.evaluate(() => __bg.segments.push({ id: "seg-full", video_id: "33rnEV3E4mA", start: 140.8, end: 320.8, votes: 1 }));
  await page2.evaluate(() => __sendToContent({ type: "refresh" }));
  await page2.waitForTimeout(1500);
  const mk2 = await page2.$$eval(".ytu-ss-timeline .cb-marker", (els) => els.map((e) => e.className));
  check("yellow stays visible (thin stripe) on top of an overlapping green break", mk2.includes("cb-marker cb-community") && mk2.includes("cb-marker cb-youtube cb-youtube-thin"), mk2);
  await page2.close();

  // 10) On-demand ads: separate ad videos inside the player
  const page3 = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  page3.on("pageerror", (e) => errors.push(String(e)));
  await page3.addInitScript(stub);
  await page3.goto("http://localhost:8123/watch/33rnEV3E4mA");
  for (const f of ["content/page-bridge.js", "content/segments.js", "content/content.js"]) await page3.addScriptTag({ path: path.join(EXT, f) });
  await page3.addStyleTag({ path: path.join(EXT, "content/content.css") });
  await page3.waitForTimeout(1500);
  await page3.evaluate(() => { fake.t = 737; fake.playing = true; fake.startAdPod([15, 30, 15]); });
  await page3.waitForTimeout(3500);
  const pod = await page3.evaluate(() => ({ inAd: !!fake.pod, t: fake.t, cls: document.querySelector("#movie_player").className }));
  check("jumps through a 3-ad on-demand break in a few seconds", !pod.inAd && !/ad-showing/.test(pod.cls), pod);
  check("show resumes where it paused (12:17)", pod.t >= 737 && pod.t < 742, pod.t);
  noticeText = await page3.textContent(".cb-notice");
  check("notice: Skipped 3 ads (~1:00)", /Skipped 3 ads \(0:5\d|1:00\)/.test(noticeText), noticeText);
  // YouTube restarts the ad when jumped → falls back to mute + 16x, then restores
  await page3.evaluate(() => { const v = document.querySelector("#movie_player video"); v.muted = false; fake.startAdPod([30], true); });
  await page3.waitForTimeout(4500);
  const fb = await page3.evaluate(() => { const v = document.querySelector("#movie_player video"); return { inAd: !!fake.pod, muted: v.muted, rate: v.playbackRate }; });
  check("falls back to mute + 16x when jumping is blocked", fb.inAd && fb.muted && fb.rate === 16, fb);
  await page3.waitForTimeout(3000);
  const fb2 = await page3.evaluate(() => { const v = document.querySelector("#movie_player video"); return { inAd: !!fake.pod, muted: v.muted, rate: v.playbackRate }; });
  check("after the ad: sound and normal speed restored", !fb2.inAd && fb2.muted === false && fb2.rate === 1, fb2);
  // Setting off → ads play normally
  await page3.evaluate(() => browser.storage.local.set({ settings: { skipOnDemandAds: false } }));
  await page3.evaluate(() => { fake.startAdPod([15]); });
  await page3.waitForTimeout(2000);
  const off = await page3.evaluate(() => ({ inAd: !!fake.pod, t: fake.pod && fake.pod.t }));
  check("with the setting off, ads play normally", off.inAd && off.t > 1, off);
  await page3.close();

  check("no JavaScript errors", errors.length === 0, errors);

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
