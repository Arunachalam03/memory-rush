"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCollector, newId, KEYS, BATCH_SIZE, QUEUE_CAP } = require("../collector.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENDPOINT = "https://script.google.com/macros/s/ABC123/exec";
const STATS = { rounds: 3, score: 60, presses: 8, accuracy: 88, avgReactionMs: 420, fastestMs: 250 };

function fakeStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
const okRes = (body) => ({ ok: true, status: 200, json: async () => body });
const acceptAll = (calls) => async (url, init) => {
  const { records } = JSON.parse(init.body);
  if (calls) calls.push({ url, init, records });
  return okRes({ ok: true, accepted: records.map((r) => r.id), duplicates: [], rejected: [] });
};

let counter = 0;
const idFn = () => "00000000-0000-4000-8000-" + String(++counter).padStart(12, "0");

function make(over = {}) {
  const storage = over.storage || fakeStorage();
  const c = createCollector({
    endpoint: ENDPOINT, storage, fetchFn: acceptAll(), idFn, now: () => Date.parse("2026-10-17T12:00:00Z"),
    appVersion: "1.1.0", ...over,
  });
  return { c, storage };
}
const granted = (over) => { const x = make(over); x.c.setConsent("granted"); return x; };

test("enabled only for https endpoints (or localhost http) with a fetch available", () => {
  assert.equal(make().c.enabled(), true);
  assert.equal(make({ endpoint: "" }).c.enabled(), false);
  assert.equal(make({ endpoint: "http://example.com/x" }).c.enabled(), false);
  assert.equal(make({ endpoint: "http://localhost:3000/x" }).c.enabled(), true);
  assert.equal(make({ endpoint: "http://127.0.0.1:8080/x" }).c.enabled(), true);
  assert.equal(make({ endpoint: undefined }).c.enabled(), false);
  assert.equal(make({ fetchFn: null }).c.enabled(), typeof fetch === "function");
});

test("consent is required first; disabled collectors never ask", () => {
  assert.equal(make().c.needsConsent(), true);
  assert.equal(make({ endpoint: "" }).c.needsConsent(), false);
  const { c } = make();
  c.setConsent("declined");
  assert.equal(c.needsConsent(), false);
  assert.throws(() => c.setConsent("maybe"));
});

test("nothing is recorded without consent or after declining", () => {
  const { c } = make();
  assert.equal(c.record(STATS), null);
  c.setConsent("declined");
  assert.equal(c.record(STATS), null);
  assert.equal(c.pending(), 0);
});

test("granting consent creates a stable anonymous UUID that persists across instances", () => {
  const { c, storage } = granted();
  const id = c.playerId();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(c.playerId(), id);
  c.setConsent("granted");
  assert.equal(c.playerId(), id);
  const again = createCollector({ endpoint: ENDPOINT, storage, fetchFn: acceptAll() });
  assert.equal(again.playerId(), id);
  assert.equal(again.consent(), "granted");
});

test("declining clears the queue and the anonymous ID; re-granting issues a new ID", () => {
  const { c } = granted();
  const first = c.playerId();
  c.record(STATS);
  assert.equal(c.pending(), 1);
  c.revoke();
  assert.equal(c.pending(), 0);
  assert.equal(c.playerId(), null);
  assert.equal(c.consent(), "declined");
  c.setConsent("granted");
  assert.notEqual(c.playerId(), first);
});

test("record has the exact expected shape, no personal fields", () => {
  const { c } = granted();
  const rec = c.record({ ...STATS, accuracy: 87.6, avgReactionMs: "420.4", fastestMs: NaN, extra: "ignored" });
  assert.deepEqual(Object.keys(rec).sort(), [
    "accuracy", "appVersion", "avgReactionMs", "fastestMs", "id", "playedAt", "playerId", "presses", "rounds", "score",
  ]);
  assert.equal(rec.playedAt, "2026-10-17T12:00:00.000Z");
  assert.equal(rec.accuracy, 88);
  assert.equal(rec.avgReactionMs, 420);
  assert.equal(rec.fastestMs, 0);
  assert.equal(rec.appVersion, "1.1.0");
  assert.equal(rec.playerId, c.playerId());
});

test("flush uploads in batches of 20 and empties the queue", async () => {
  const calls = [];
  const { c } = granted({ fetchFn: acceptAll(calls) });
  for (let i = 0; i < 45; i++) c.record(STATS);
  const r = await c.flush();
  assert.deepEqual([r.status, r.sent, r.remaining], ["ok", 45, 0]);
  assert.deepEqual(calls.map((x) => x.records.length), [BATCH_SIZE, BATCH_SIZE, 5]);
  assert.equal(c.pending(), 0);
});

test("request is a text/plain POST (no CORS preflight) with a JSON body", async () => {
  const calls = [];
  const { c } = granted({ fetchFn: acceptAll(calls) });
  c.record(STATS);
  await c.flush();
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].init.headers["Content-Type"], /^text\/plain/);
  assert.equal(Array.isArray(JSON.parse(calls[0].init.body).records), true);
});

test("offline: nothing is lost, and the same records go out when back online", async () => {
  let online = false;
  const sent = [];
  const fetchFn = async (url, init) => {
    if (!online) throw new TypeError("Failed to fetch");
    return acceptAll(sent)(url, init);
  };
  const { c } = granted({ fetchFn });
  c.record(STATS); c.record(STATS); c.record(STATS);
  const r1 = await c.flush();
  assert.deepEqual([r1.status, r1.remaining], ["offline", 3]);
  assert.equal(c.pending(), 3);
  online = true;
  const r2 = await c.flush();
  assert.deepEqual([r2.status, r2.sent, r2.remaining], ["ok", 3, 0]);
  assert.equal(sent[0].records.length, 3);
});

test("queue survives a page reload (new collector, same storage)", async () => {
  const storage = fakeStorage();
  const a = granted({ storage, fetchFn: async () => { throw new TypeError("offline"); } }).c;
  a.record(STATS); a.record(STATS);
  await a.flush();
  const calls = [];
  const b = createCollector({ endpoint: ENDPOINT, storage, fetchFn: acceptAll(calls) });
  assert.equal(b.pending(), 2);
  assert.equal((await b.flush()).sent, 2);
  assert.equal(calls[0].records.length, 2);
});

test("HTTP errors keep the queue and report 'error'", async () => {
  const { c } = granted({ fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  c.record(STATS);
  const r = await c.flush();
  assert.deepEqual([r.status, r.remaining], ["error", 1]);
});

test("malformed or negative server replies keep the queue (no data loss)", async () => {
  for (const body of [null, {}, { ok: false }, { ok: true }, { ok: true, accepted: "x" }]) {
    const { c } = granted({ fetchFn: async () => okRes(body) });
    c.record(STATS);
    const r = await c.flush();
    assert.equal(r.status, "error", JSON.stringify(body));
    assert.equal(c.pending(), 1);
  }
  const { c } = granted({ fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }) });
  c.record(STATS);
  assert.equal((await c.flush()).status, "error");
  assert.equal(c.pending(), 1);
});

test("duplicates and permanently rejected records are dropped; accepted counted", async () => {
  const fetchFn = async (url, init) => {
    const { records } = JSON.parse(init.body);
    return okRes({
      ok: true,
      accepted: [records[0].id],
      duplicates: [records[1].id],
      rejected: [{ id: records[2].id, reason: "bad_rounds" }],
    });
  };
  const { c } = granted({ fetchFn });
  c.record(STATS); c.record(STATS); c.record(STATS);
  const r = await c.flush();
  assert.deepEqual([r.status, r.sent, r.remaining], ["ok", 1, 0]);
});

test("records the server neither accepts nor rejects (throttled) are kept, with no infinite loop", async () => {
  let calls = 0;
  const fetchFn = async (url, init) => {
    calls++;
    const { records } = JSON.parse(init.body);
    // first call stores one record, then the server throttles the rest
    const accepted = calls === 1 ? [records[0].id] : [];
    return okRes({ ok: true, accepted, duplicates: [], rejected: [], throttled: records.length - accepted.length });
  };
  const { c } = granted({ fetchFn });
  c.record(STATS); c.record(STATS); c.record(STATS);
  const r = await c.flush();
  assert.equal(r.status, "error");
  assert.equal(r.sent, 1);
  assert.equal(r.remaining, 2);
  assert.equal(calls, 2); // second call made no progress, so it stops instead of looping
});

test("overlapping flush calls do not double-send", async () => {
  const calls = [];
  const slow = async (url, init) => { await new Promise((r) => setTimeout(r, 20)); return acceptAll(calls)(url, init); };
  const { c } = granted({ fetchFn: slow });
  c.record(STATS);
  const [a, b] = await Promise.all([c.flush(), c.flush()]);
  assert.deepEqual([a.status, b.status].sort(), ["busy", "ok"]);
  assert.equal(calls.length, 1);
});

test("a record added during a flush is not lost", async () => {
  const calls = [];
  let c;
  const fetchFn = async (url, init) => {
    if (calls.length === 0) c.record(STATS); // game finished while the first upload was in flight
    return acceptAll(calls)(url, init);
  };
  ({ c } = granted({ fetchFn }));
  c.record(STATS);
  const r = await c.flush();
  assert.equal(r.sent, 2);
  assert.equal(c.pending(), 0);
});

test("queue is capped at QUEUE_CAP, dropping the oldest", () => {
  const { c, storage } = granted();
  const first = c.record(STATS);
  let last;
  for (let i = 0; i < QUEUE_CAP + 4; i++) last = c.record(STATS);
  assert.equal(c.pending(), QUEUE_CAP);
  const ids = JSON.parse(storage.getItem(KEYS.queue)).map((r) => r.id);
  assert.ok(!ids.includes(first.id), "oldest record was dropped");
  assert.equal(ids[ids.length - 1], last.id, "newest record was kept");
});

test("flush does nothing without consent or when disabled", async () => {
  let called = 0;
  const fetchFn = async () => { called++; return okRes({}); };
  const noConsent = make({ fetchFn }).c;
  assert.equal((await noConsent.flush()).status, "disabled");
  const off = createCollector({ endpoint: "", fetchFn });
  assert.equal((await off.flush()).status, "disabled");
  assert.equal(called, 0);
});

test("corrupted stored queue is ignored safely", async () => {
  const storage = fakeStorage();
  const { c } = granted({ storage });
  storage.setItem(KEYS.queue, "{not json");
  assert.equal(c.pending(), 0);
  storage.setItem(KEYS.queue, JSON.stringify({ not: "an array" }));
  assert.equal(c.pending(), 0);
  storage.setItem(KEYS.queue, JSON.stringify([null, 5, { noId: true }]));
  assert.equal(c.pending(), 0);
  assert.ok(c.record(STATS));
  assert.equal(c.pending(), 1);
});

test("a storage that throws still works for the session via the in-memory mirror", async () => {
  const broken = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); },
  };
  const calls = [];
  const { c } = granted({ storage: broken, fetchFn: acceptAll(calls) });
  assert.ok(c.playerId());
  assert.ok(c.record(STATS));
  assert.equal((await c.flush()).sent, 1);
});

test("a hanging request is aborted by the timeout and treated as offline", async () => {
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const { c } = granted({ fetchFn: hang, timeoutMs: 20 });
  c.record(STATS);
  const r = await c.flush();
  assert.deepEqual([r.status, r.remaining], ["offline", 1]);
});

test("newId returns RFC4122 v4 UUIDs in every environment", () => {
  assert.match(newId(), UUID);
  assert.match(newId({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }), UUID);
  const fake = { getRandomValues: (b) => { b.fill(255); return b; } };
  assert.match(newId(fake), UUID);
  assert.match(newId(null), UUID);
  const set = new Set();
  for (let i = 0; i < 1000; i++) set.add(newId(null));
  assert.equal(set.size, 1000);
});
