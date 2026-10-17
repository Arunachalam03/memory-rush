"use strict";
// Smoke test: serves the site locally and checks every file is reachable and wired together.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function serve() {
  return http.createServer((req, res) => {
    const url = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const file = path.join(ROOT, path.normalize(url));
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ port, path: p }, (r) => {
      let body = ""; r.on("data", (c) => (body += c)); r.on("end", () => resolve({ status: r.statusCode, body }));
    }).on("error", reject);
  });
}

test("site serves index, scripts and styles; index references them", async () => {
  const s = serve();
  await new Promise((r) => s.listen(0, r));
  const port = s.address().port;
  try {
    const index = await get(port, "/");
    assert.equal(index.status, 200);
    for (const asset of ["config.js", "game.js", "collector.js", "app.js", "style.css"]) {
      assert.ok(index.body.includes(asset), `index.html should reference ${asset}`);
      assert.equal((await get(port, "/" + asset)).status, 200, asset);
    }
    assert.equal((await get(port, "/nope.txt")).status, 404);
  } finally { s.close(); }
});

test("scripts load in dependency order, app.js last", () => {
  const html = read("index.html");
  const order = ["config.js", "game.js", "collector.js", "app.js"].map((f) => html.indexOf(`src="${f}"`));
  assert.ok(order.every((i) => i > -1));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("index.html has every element id that app.js looks up, and 4 pads", () => {
  const html = read("index.html");
  const app = read("app.js");
  const ids = [...app.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 15);
  for (const id of new Set(ids)) assert.ok(html.includes(`id="${id}"`), `missing #${id} in index.html`);
  assert.equal((html.match(/class="pad"/g) || []).length, 4);
});

test("consent and privacy dialogs start hidden, and the consent text states what is collected", () => {
  const html = read("index.html");
  assert.match(html, /id="consent"[^>]*hidden/);
  assert.match(html, /id="privacy"[^>]*hidden/);
  assert.match(html, /id="privacy-open"[^>]*hidden/);
  const consent = html.slice(html.indexOf('id="consent"'), html.indexOf('id="privacy"'));
  for (const phrase of ["Anonymous", "No name, email, phone or location", "say no and still play"]) {
    assert.ok(consent.includes(phrase), `consent text should mention: ${phrase}`);
  }
  assert.ok(consent.includes('id="consent-yes"') && consent.includes('id="consent-no"'));
});

test("app.js records only after consent and uses the privacy controls", () => {
  const app = read("app.js");
  assert.ok(app.includes("collector.needsConsent()"));
  assert.ok(app.includes("collector.record(st)"));
  assert.ok(app.includes("collector.revoke()"));
  assert.ok(/addEventListener\("online"/.test(app), "retries when the connection returns");
});

test("config.js: collection is off or points at a valid Apps Script URL", () => {
  const sandbox = { window: {} };
  new Function("window", read("config.js"))(sandbox.window);
  const cfg = sandbox.window.MEMORY_RUSH_CONFIG;
  assert.ok(cfg && typeof cfg.endpoint === "string" && cfg.appVersion);
  assert.ok(cfg.endpoint === "" || /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(cfg.endpoint));
});

test("share preview: OG tags present and image is 1200x630 PNG under 300KB", () => {
  const html = read("index.html");
  for (const tag of ["og:title", "og:description", "og:image", "og:url"]) {
    assert.ok(html.includes(`property="${tag}"`), `missing ${tag}`);
  }
  assert.ok(html.includes("__SITE_URL__og.png"), "og:image must use the deploy-time URL placeholder");
  const png = fs.readFileSync(path.join(ROOT, "og.png"));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.ok(png.length < 300 * 1024);
  assert.ok(fs.existsSync(path.join(ROOT, "icon.png")));
});

test("deploy workflow ships every site file (not tests or the backend) and substitutes the URL", () => {
  const wf = read(".github/workflows/deploy.yml");
  for (const f of ["index.html", "style.css", "config.js", "game.js", "collector.js", "app.js", "og.png", "icon.png"]) {
    assert.ok(wf.includes(f), `workflow should copy ${f}`);
  }
  assert.ok(!/apps-script|test\//.test(wf.split("cp ")[1].split("\n")[0]), "backend and tests must not be published");
  assert.ok(wf.includes("__SITE_URL__"));
});

test("set-endpoint script accepts a real-looking URL and rejects everything else", () => {
  const script = path.join(ROOT, "scripts", "set-endpoint.js");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mr-")), "config.js");
  fs.copyFileSync(path.join(ROOT, "config.js"), tmp);
  const good = "https://script.google.com/macros/s/AKfycbx_123-abc/exec";
  execFileSync("node", [script, good, tmp]);
  assert.ok(fs.readFileSync(tmp, "utf8").includes(`endpoint: "${good}"`));
  for (const bad of ["", "http://script.google.com/macros/s/X/exec", "https://evil.example/macros/s/X/exec",
    "https://script.google.com/home/projects/abc/edit", `${good}"; alert(1);//`]) {
    const r = spawnSync("node", [script, bad, tmp]);
    assert.notEqual(r.status, 0, `should reject: ${bad}`);
  }
  assert.ok(fs.readFileSync(tmp, "utf8").includes(`endpoint: "${good}"`), "config unchanged after rejections");
});
