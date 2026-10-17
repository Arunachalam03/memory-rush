"use strict";
// End to end: real HTTP, the real Code.gs request handler, the real collector.
// Only Google's Sheet and cache are replaced by in-memory fakes.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCollector } = require("../collector.js");
const { createGame, mulberry32 } = require("../game.js");

const sandbox = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8"), sandbox);
const gs = sandbox.module.exports;

function startFakeAppsScript() {
  const rows = [];
  const ids = new Set();
  const hits = { count: 0, contentTypes: [] };
  const deps = {
    appendRows: (r) => r.forEach((x) => { rows.push(x); ids.add(x[1]); }),
    hasId: (id) => ids.has(id),
    rateLimit: () => true,
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.count++;
      hits.contentTypes.push(req.headers["content-type"]);
      const out = JSON.stringify(gs.handlePost_(body, deps, Date.now()));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(out);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, rows, hits, url: `http://127.0.0.1:${server.address().port}/exec` })));
}

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function playGame(seed) {
  const g = createGame({ rng: mulberry32(seed) });
  g.start(); g.beginInput();
  for (let round = 0; round < 3; round++) {
    for (const pad of g.state.sequence.slice()) g.press(pad, 300 + round * 10);
    g.nextRound(); g.beginInput();
  }
  g.press((g.state.sequence[0] + 1) % 4, 350); // wrong press ends the game
  return g.stats();
}

test("real games reach the sheet; offline play is queued and delivered later; retries never duplicate", async () => {
  const sheet = await startFakeAppsScript();
  try {
    let mode = "offline"; // offline | lose-reply | online
    const fetchFn = async (url, init) => {
      if (mode === "offline") throw new TypeError("Failed to fetch");
      const res = await fetch(url, init); // the server really receives and stores it
      if (mode === "lose-reply") throw new TypeError("connection dropped before the reply arrived");
      return res;
    };
    const c = createCollector({ endpoint: sheet.url, storage: fakeStorage(), fetchFn, appVersion: "1.1.0" });
    assert.equal(c.needsConsent(), true);
    c.setConsent("granted");

    // three finished games while offline
    for (const seed of [1, 2, 3]) c.record(playGame(seed));
    assert.equal((await c.flush()).status, "offline");
    assert.equal(c.pending(), 3);
    assert.equal(sheet.rows.length, 0);

    // the server stores them but the reply is lost: the client must keep them queued
    mode = "lose-reply";
    assert.equal((await c.flush()).status, "offline");
    assert.equal(c.pending(), 3);
    assert.equal(sheet.rows.length, 3);

    // back online: the retry is acknowledged as duplicates, the queue empties, no extra rows
    mode = "online";
    const r = await c.flush();
    assert.deepEqual([r.status, r.remaining], ["ok", 0]);
    assert.equal(sheet.rows.length, 3);
    assert.equal(new Set(sheet.rows.map((x) => x[1])).size, 3);

    // a new game after recovery goes straight through
    c.record(playGame(4));
    assert.equal((await c.flush()).sent, 1);
    assert.equal(sheet.rows.length, 4);

    // stored values are the real stats, tied to one anonymous id, in HEADERS order
    const idx = (name) => gs.HEADERS.indexOf(name);
    for (const row of sheet.rows) {
      assert.equal(row.length, gs.HEADERS.length);
      assert.equal(row[idx("playerId")], c.playerId());
      assert.equal(row[idx("rounds")], 3);
      assert.equal(row[idx("score")], 60);
      assert.equal(row[idx("appVersion")], "1.1.0");
    }
    assert.ok(sheet.hits.contentTypes.every((t) => /^text\/plain/.test(t)));
  } finally { sheet.server.close(); }
});

test("a player who declines never contacts the server", async () => {
  const sheet = await startFakeAppsScript();
  try {
    const c = createCollector({ endpoint: sheet.url, storage: fakeStorage() });
    c.setConsent("declined");
    assert.equal(c.record(playGame(1)), null);
    assert.equal((await c.flush()).status, "disabled");
    assert.equal(sheet.hits.count, 0);
  } finally { sheet.server.close(); }
});

test("a withdrawn player's queued results are deleted locally and never sent", async () => {
  const sheet = await startFakeAppsScript();
  try {
    const c = createCollector({ endpoint: sheet.url, storage: fakeStorage(), fetchFn: async () => { throw new TypeError("offline"); } });
    c.setConsent("granted");
    c.record(playGame(1));
    c.revoke();
    assert.equal(c.pending(), 0);
    assert.equal(sheet.hits.count, 0);
  } finally { sheet.server.close(); }
});
