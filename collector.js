/* Consent, anonymous ID, offline queue and upload. No DOM; unit tested. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MemoryRushCollector = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var KEYS = {
    consent: "memoryRush.consent",
    playerId: "memoryRush.playerId",
    queue: "memoryRush.queue",
  };
  var BATCH_SIZE = 20;
  var QUEUE_CAP = 500;
  var DEFAULT_TIMEOUT_MS = 10000;
  var LOCAL_HTTP = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//;

  function newId(cryptoObj) {
    var c = cryptoObj !== undefined ? cryptoObj : (typeof crypto !== "undefined" ? crypto : null);
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    var b = new Uint8Array(16);
    if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  function memoryStore() {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; },
    };
  }

  function toInt(x) {
    var n = Math.round(Number(x));
    return isFinite(n) ? n : 0;
  }

  function createCollector(opts) {
    opts = opts || {};
    var endpoint = typeof opts.endpoint === "string" ? opts.endpoint.trim() : "";
    var appVersion = opts.appVersion || "1.0.0";
    var now = opts.now || Date.now;
    var idFn = opts.idFn || function () { return newId(); };
    var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    var fetchFn = opts.fetchFn || (typeof fetch === "function" ? function () { return fetch.apply(null, arguments); } : null);
    var storage = opts.storage || null;
    var mem = memoryStore(); // mirror, so a broken localStorage never loses data mid-session
    var flushing = false;

    function get(k) {
      var v = null;
      try { if (storage) v = storage.getItem(k); } catch (e) { v = null; }
      return v === null || v === undefined ? mem.getItem(k) : v;
    }
    function set(k, v) {
      mem.setItem(k, v);
      try { if (storage) storage.setItem(k, v); } catch (e) { /* mirror still holds it */ }
    }
    function del(k) {
      mem.removeItem(k);
      try { if (storage) storage.removeItem(k); } catch (e) { /* ignore */ }
    }

    function enabled() {
      return !!fetchFn && (/^https:\/\//.test(endpoint) || LOCAL_HTTP.test(endpoint));
    }
    function consent() {
      var v = get(KEYS.consent);
      return v === "granted" || v === "declined" ? v : null;
    }
    function needsConsent() { return enabled() && consent() === null; }
    function playerId() { return get(KEYS.playerId); }

    function setConsent(value) {
      if (value !== "granted" && value !== "declined") throw new Error("consent must be 'granted' or 'declined'");
      set(KEYS.consent, value);
      if (value === "granted") {
        if (!playerId()) set(KEYS.playerId, idFn());
      } else {
        del(KEYS.queue);
        del(KEYS.playerId);
      }
    }

    function readQueue() {
      try {
        var q = JSON.parse(get(KEYS.queue) || "[]");
        if (!Array.isArray(q)) return [];
        return q.filter(function (r) { return r && typeof r === "object" && typeof r.id === "string"; });
      } catch (e) { return []; }
    }
    function writeQueue(q) { set(KEYS.queue, JSON.stringify(q)); }
    function pending() { return readQueue().length; }

    function record(stats) {
      if (!enabled() || consent() !== "granted" || !playerId()) return null;
      var s = stats || {};
      var rec = {
        id: idFn(),
        playerId: playerId(),
        playedAt: new Date(now()).toISOString(),
        rounds: toInt(s.rounds),
        score: toInt(s.score),
        presses: toInt(s.presses),
        accuracy: toInt(s.accuracy),
        avgReactionMs: toInt(s.avgReactionMs),
        fastestMs: toInt(s.fastestMs),
        appVersion: appVersion,
      };
      var q = readQueue();
      q.push(rec);
      if (q.length > QUEUE_CAP) q = q.slice(q.length - QUEUE_CAP);
      writeQueue(q);
      return rec;
    }

    function post(batch) {
      var ctrl = typeof AbortController === "function" ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
      var init = {
        method: "POST",
        // text/plain keeps this a "simple" request: no CORS preflight (Apps Script can't answer one).
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ records: batch }),
      };
      if (ctrl) init.signal = ctrl.signal;
      return Promise.resolve()
        .then(function () { return fetchFn(endpoint, init); })
        .then(function (res) {
          if (!res || !res.ok) {
            var err = new Error("http " + (res && res.status));
            err.kind = "http";
            throw err;
          }
          return res.json().catch(function () { return null; });
        })
        .then(
          function (data) { if (timer) clearTimeout(timer); return data; },
          function (e) { if (timer) clearTimeout(timer); throw e; }
        );
    }

    function ids(arr) { return Array.isArray(arr) ? arr.filter(function (x) { return typeof x === "string"; }) : []; }

    /** Never rejects. status: ok | disabled | busy | offline | error */
    function flush() {
      if (!enabled() || consent() !== "granted") return Promise.resolve({ status: "disabled", sent: 0, remaining: pending() });
      if (flushing) return Promise.resolve({ status: "busy", sent: 0, remaining: pending() });
      flushing = true;
      var sent = 0;

      function step() {
        var q = readQueue();
        if (!q.length) return { status: "ok", sent: sent, remaining: 0 };
        return post(q.slice(0, BATCH_SIZE)).then(
          function (data) {
            if (!data || data.ok !== true || !Array.isArray(data.accepted)) {
              return { status: "error", sent: sent, remaining: pending() };
            }
            var rejected = Array.isArray(data.rejected)
              ? data.rejected.map(function (r) { return r && r.id; }).filter(function (x) { return typeof x === "string"; })
              : [];
            var done = {};
            ids(data.accepted).concat(ids(data.duplicates), rejected).forEach(function (id) { done[id] = true; });
            var before = readQueue();
            var after = before.filter(function (r) { return !done[r.id]; });
            if (after.length === before.length) return { status: "error", sent: sent, remaining: after.length }; // no progress
            writeQueue(after);
            sent += ids(data.accepted).length;
            return step();
          },
          function (e) {
            return { status: e && e.kind === "http" ? "error" : "offline", sent: sent, remaining: pending() };
          }
        );
      }

      return Promise.resolve()
        .then(step)
        .catch(function () { return { status: "error", sent: sent, remaining: pending() }; })
        .then(function (r) { flushing = false; return r; });
    }

    return {
      enabled: enabled, consent: consent, needsConsent: needsConsent, setConsent: setConsent,
      revoke: function () { setConsent("declined"); },
      playerId: playerId, record: record, flush: flush, pending: pending,
    };
  }

  return { createCollector: createCollector, newId: newId, KEYS: KEYS, BATCH_SIZE: BATCH_SIZE, QUEUE_CAP: QUEUE_CAP };
});
