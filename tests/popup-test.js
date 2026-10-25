const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require(process.env.PW_MODULE || "playwright");
const EXT = path.join(__dirname, "..", "extension");
const stub = `(() => {
  const store = { localSegments: {
    "33rnEV3E4mA": [{ start: 141, end: 201, title: "Twisted Christian", duration: 1865 }, { start: 600.5, end: 662 }],
    "abcDEF12345": [{ start: 300, end: 420, title: "Other show" }]
  }, stats: { skips: 3, secondsSaved: 185, submissions: 0 } };
  window.__subs = [];
  window.browser = {
    storage: { local: {
      get: async (k) => { const ks = typeof k === "string" ? [k] : k; const o = {}; ks.forEach(x => { if (x in store) o[x] = JSON.parse(JSON.stringify(store[x])); }); return o; },
      set: async (o) => { for (const k in o) store[k] = JSON.parse(JSON.stringify(o[k])); } } },
    tabs: { query: async () => [{ id: 1, url: "https://tv.youtube.com/watch/33rnEV3E4mA" }],
            sendMessage: async () => ({ videoId: "33rnEV3E4mA", title: "Twisted Christian", youtubeBreaks: 1, communityBreaks: 0, communityStatus: "not-configured", youtubeList: [{ start: 140.773, end: 200.799 }, { start: 791.29, end: 851.316 }] }) },
    runtime: { sendMessage: async (m) => { if (m.type === "serverStatus") return { ok: !!window.__server }; if (m.type === "submit") { __subs.push(m); return { ok: true }; } return { ok: false }; } }
  };
  window.__store = store;
})();`;
const srv = http.createServer((req, res) => {
  const f = path.join(EXT, decodeURIComponent(req.url.split("?")[0]));
  if (!f.startsWith(EXT) || !fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.setHeader("Content-Type", f.endsWith(".html") ? "text/html" : f.endsWith(".css") ? "text/css" : f.endsWith(".png") ? "image/png" : "text/javascript");
  res.end(fs.readFileSync(f));
}).listen(8124);
const ok = []; const check = (n, c, x) => { ok.push(!!c); console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  → " + JSON.stringify(x) : "")); };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 330, height: 760 } });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(String(e)));
  await p.addInitScript(stub);
  await p.goto("http://localhost:8124/popup/popup.html"); await p.waitForTimeout(600);
  const rows = await p.$$eval("#saved-list li", ls => ls.map(l => l.textContent));
  check("lists saved breaks, current recording first", rows[0].includes("Twisted Christian") && rows[0].includes("open now") && rows.length === 5, rows);
  check("share button hidden while server not set up", await p.isHidden("#upload"));
  const ytl = await p.textContent("#yt-list");
  check("popup lists YouTube TV mark times", ytl === "YouTube TV marks: 2:21–3:21, 13:11–14:11", ytl);
  await p.screenshot({ path: (process.env.OUT_DIR || __dirname) + "/shot-popup.png", fullPage: true });
  const [dl] = await Promise.all([p.waitForEvent("download"), p.click("#export")]);
  const data = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
  check("exports a JSON file with all 3 breaks", data.breaks.length === 3 && data.breaks[0].startTime === "2:21" && data.breaks[0].recordingUrl.endsWith("33rnEV3E4mA"), { file: dl.suggestedFilename(), first: data.breaks[0] });
  await p.locator("#saved-list li button.del").first().click(); await p.waitForTimeout(300);
  const left = await p.evaluate(() => __store.localSegments["33rnEV3E4mA"].length);
  check("delete removes one saved break", left === 1, left);
  // with a server: share all
  await p.evaluate(() => { window.__server = true; }); await p.reload(); await p.evaluate(() => { window.__server = true; });
  const p2 = await ctx.newPage(); await p2.addInitScript(stub + "window.__server = true;");
  await p2.goto("http://localhost:8124/popup/popup.html"); await p2.waitForTimeout(600);
  check("share button shown when server connected", await p2.isVisible("#upload"));
  await p2.click("#upload"); await p2.waitForTimeout(600);
  const subs = await p2.evaluate(() => __subs.length); const remaining = await p2.evaluate(() => Object.keys(__store.localSegments).length);
  check("shares all 3 and clears them locally", subs === 3 && remaining === 0, { subs, remaining, msg: await p2.textContent("#saved-msg") });
  check("no JS errors", errs.length === 0, errs);
  await b.close(); srv.close(); console.log(ok.filter(Boolean).length + "/" + ok.length + " passed"); process.exit(ok.every(Boolean) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
