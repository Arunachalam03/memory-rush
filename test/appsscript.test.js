"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x)); // normalise objects from the vm realm

// ---- load Code.gs the way Apps Script would, with fake Google services ----
function load() {
  const rows = [];
  const state = { rows, frozen: 0, lockReleased: 0, failSheet: false };
  const sheet = {
    getLastRow: () => rows.length,
    appendRow: (r) => { rows.push(r); },
    setFrozenRows: () => { state.frozen = 1; },
    getRange: (r, c, n) => ({
      setValues: (vals) => vals.forEach((v, i) => { rows[r - 1 + i] = v; }),
      createTextFinder: (text) => {
        const f = {
          matchEntireCell: () => f,
          findNext: () => {
            for (let i = r - 1; i < r - 1 + n; i++) if (rows[i] && String(rows[i][c - 1]) === text) return {};
            return null;
          },
        };
        return f;
      },
    }),
  };
  const ss = { getSheetByName: () => sheet, insertSheet: () => sheet };
  const cacheMap = {};
  const sandbox = {
    module: { exports: {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() { state.lockReleased++; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (k in cacheMap ? cacheMap[k] : null), put: (k, v) => { cacheMap[k] = v; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => { if (state.failSheet) throw new Error("boom"); return ss; } },
    ContentService: { createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }), MimeType: { JSON: "json" } },
  };
  vm.runInNewContext(SRC, sandbox);
  return { api: sandbox.module.exports, state, sandbox };
}

const { api } = load();
const NOW = Date.parse("2026-10-17T12:00:00Z");
const uuid = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const rec = (o = {}) => ({
  id: uuid(1), playerId: uuid(900), playedAt: "2026-10-17T11:59:00.000Z",
  rounds: 3, score: 60, presses: 8, accuracy: 88, avgReactionMs: 420, fastestMs: 250, appVersion: "1.1.0", ...o,
});
const reason = (o) => api.validateRecord_(rec(o), NOW).reason;

// ---- validation ----
test("a valid record is accepted and normalised into a row matching HEADERS", () => {
  const v = api.validateRecord_(rec({ playedAt: "2026-10-17T17:29:00+05:30" }), NOW);
  assert.equal(v.ok, true);
  const row = plain(v.row);
  assert.equal(row.length, api.HEADERS.length);
  assert.equal(row[0], "2026-10-17T12:00:00.000Z");
  assert.equal(row[3], "2026-10-17T11:59:00.000Z");
  assert.deepEqual(row.slice(1, 3), [uuid(1), uuid(900)]);
});

test("rejects bad ids", () => {
  assert.equal(reason({ id: "abc" }), "bad_id");
  assert.equal(reason({ id: 5 }), "bad_id");
  assert.equal(reason({ id: "=HYPERLINK(\"http://evil\")" }), "bad_id");
  assert.equal(reason({ playerId: "nope" }), "bad_player_id");
});

test("rejects bad or out-of-window timestamps", () => {
  assert.equal(reason({ playedAt: "yesterday" }), "bad_played_at");
  assert.equal(reason({ playedAt: 12345 }), "bad_played_at");
  assert.equal(reason({ playedAt: "2026-10-19T12:00:00Z" }), "played_at_in_future");
  assert.equal(reason({ playedAt: "2026-09-01T12:00:00Z" }), "played_at_too_old");
  assert.equal(api.validateRecord_(rec({ playedAt: "2026-10-10T12:00:00Z" }), NOW).ok, true); // queued offline for a week
});

test("rejects out-of-range or non-integer numbers", () => {
  assert.equal(reason({ rounds: 201 }), "bad_rounds");
  assert.equal(reason({ rounds: -1 }), "bad_rounds");
  assert.equal(reason({ rounds: 2.5 }), "bad_rounds");
  assert.equal(reason({ rounds: "3" }), "bad_rounds");
  assert.equal(reason({ score: 65 }), "bad_score");
  assert.equal(reason({ score: 70 }), "score_exceeds_rounds");
  assert.equal(reason({ presses: 2 }), "bad_presses");
  assert.equal(reason({ accuracy: 101 }), "bad_accuracy");
  assert.equal(reason({ avgReactionMs: 60001 }), "bad_avg_reaction");
  assert.equal(reason({ fastestMs: 500 }), "bad_fastest");
  assert.equal(reason({ fastestMs: -1 }), "bad_fastest");
  assert.equal(reason({ accuracy: NaN }), "bad_accuracy");
});

test("rejects formula-injection style versions and non-objects", () => {
  assert.equal(reason({ appVersion: "=1+1" }), "bad_app_version");
  assert.equal(reason({ appVersion: "a".repeat(21) }), "bad_app_version");
  for (const bad of [null, undefined, 5, "x", []]) assert.equal(api.validateRecord_(bad, NOW).reason, "not_an_object");
});

test("a zero-round game (failed first press) is valid", () => {
  const v = api.validateRecord_(rec({ rounds: 0, score: 0, presses: 1, accuracy: 0 }), NOW);
  assert.equal(v.ok, true);
});

// ---- handlePost_ ----
function deps({ existing = [], allow = true } = {}) {
  const rows = [];
  const ids = new Set(existing);
  return {
    rows,
    appendRows: (r) => { rows.push(...r); r.forEach((x) => ids.add(x[1])); },
    hasId: (id) => ids.has(id),
    rateLimit: () => allow,
  };
}
const post = (body, d = deps()) => ({ out: plain(api.handlePost_(typeof body === "string" ? body : JSON.stringify(body), d, NOW)), d });

test("bad requests are refused", () => {
  assert.equal(post("").out.error, "bad_request");
  assert.equal(post("{oops").out.error, "bad_request");
  assert.equal(post({}).out.error, "bad_request");
  assert.equal(post({ records: "x" }).out.error, "bad_request");
  assert.equal(post({ records: [] }).out.error, "bad_request");
  assert.equal(post({ records: Array.from({ length: api.MAX_BATCH + 1 }, (_, i) => rec({ id: uuid(i + 1) })) }).out.error, "bad_request");
  assert.equal(post("x".repeat(20001)).out.error, "bad_request");
  assert.equal(api.handlePost_(undefined, deps(), NOW).ok, false);
});

test("valid records are appended once", () => {
  const { out, d } = post({ records: [rec({ id: uuid(1) }), rec({ id: uuid(2) })] });
  assert.deepEqual(out.accepted, [uuid(1), uuid(2)]);
  assert.equal(d.rows.length, 2);
});

test("duplicates (already stored, or repeated in one batch) are acknowledged, not re-added", () => {
  const { out, d } = post({ records: [rec({ id: uuid(1) }), rec({ id: uuid(2) }), rec({ id: uuid(2) })] }, deps({ existing: [uuid(1)] }));
  assert.deepEqual(out.accepted, [uuid(2)]);
  assert.deepEqual(out.duplicates, [uuid(1), uuid(2)]);
  assert.equal(d.rows.length, 1);
});

test("a mixed batch is handled record by record", () => {
  const { out, d } = post({ records: [rec({ id: uuid(1) }), rec({ id: uuid(2), rounds: 999 }), { id: 7 }, rec({ id: uuid(3) })] });
  assert.deepEqual(out.accepted, [uuid(1), uuid(3)]);
  assert.deepEqual(out.rejected, [{ id: uuid(2), reason: "bad_rounds" }, { id: null, reason: "bad_id" }]);
  assert.equal(d.rows.length, 2);
});

test("rate-limited records are neither stored nor rejected, so the client retries later", () => {
  const { out, d } = post({ records: [rec({ id: uuid(1) })] }, deps({ allow: false }));
  assert.deepEqual([out.accepted.length, out.rejected.length, out.throttled], [0, 0, 1]);
  assert.equal(d.rows.length, 0);
});

// ---- doPost / doGet wiring with fake Google services ----
const body = (records) => ({ postData: { contents: JSON.stringify({ records }) } });
const run = (ctx, e) => JSON.parse(ctx.api.doPost(e).text);

test("doPost creates the header row once, stores rows, and releases the lock", () => {
  const ctx = load();
  const out = run(ctx, body([rec()]));
  assert.deepEqual(out.accepted, [uuid(1)]);
  assert.deepEqual(plain(ctx.state.rows[0]), plain(ctx.api.HEADERS));
  assert.equal(ctx.state.rows.length, 2);
  assert.equal(ctx.state.frozen, 1);
  assert.equal(ctx.state.lockReleased, 1);
});

test("doPost is idempotent when the same record is sent again", () => {
  const ctx = load();
  run(ctx, body([rec()]));
  const again = run(ctx, body([rec()]));
  assert.deepEqual(again.duplicates, [uuid(1)]);
  assert.equal(ctx.state.rows.length, 2);
});

test("doPost enforces the per-player hourly limit", () => {
  const ctx = load();
  const limit = ctx.api.RATE_LIMIT_PER_HOUR;
  let n = 0;
  while (n < limit) {
    const batch = [];
    for (let i = 0; i < 20 && n < limit; i++, n++) batch.push(rec({ id: uuid(n + 1) }));
    assert.equal(run(ctx, body(batch)).throttled, 0);
  }
  const over = run(ctx, body([rec({ id: uuid(limit + 1) })]));
  assert.equal(over.throttled, 1);
  assert.equal(over.accepted.length, 0);
  assert.equal(ctx.state.rows.length, limit + 1); // + header
  const other = run(ctx, body([rec({ id: uuid(5000), playerId: uuid(901) })])); // other players unaffected
  assert.equal(other.accepted.length, 1);
});

test("doPost never leaks details on internal failure, and still releases the lock", () => {
  const ctx = load();
  ctx.state.failSheet = true;
  assert.deepEqual(run(ctx, body([rec()])), { ok: false, error: "server_error" });
  assert.equal(ctx.state.lockReleased, 1);
});

test("doPost tolerates a missing body; doGet is a health check that returns no data", () => {
  const ctx = load();
  assert.equal(run(ctx, undefined).error, "bad_request");
  assert.equal(run(ctx, {}).error, "bad_request");
  const health = JSON.parse(ctx.api.doGet().text);
  assert.deepEqual(health, { ok: true, service: "memory-rush-collector" });
});

test("ensureHeaders_ does not overwrite an existing sheet", () => {
  const calls = [];
  api.ensureHeaders_({ getLastRow: () => 5, appendRow: () => calls.push("append"), setFrozenRows: () => calls.push("freeze") });
  assert.deepEqual(calls, []);
});
