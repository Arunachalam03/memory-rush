/**
 * Memory Rush data collector: Google Apps Script web app.
 *
 * Paste this whole file into the Apps Script editor of a Google Sheet
 * (Extensions -> Apps Script) and deploy it as a Web app.
 * See README.md for the exact steps.
 *
 * Design:
 *  - Write-only: doPost appends rows; nothing in this script returns sheet data.
 *  - Every field is validated; anything unexpected is rejected (this also
 *    prevents spreadsheet formula injection, because no free text is stored).
 *  - Idempotent: a record id that is already in the sheet is acknowledged as a
 *    duplicate, so the offline queue on the client can safely retry.
 *  - Light per-player rate limit using CacheService.
 */

var SHEET_NAME = "Responses";
var HEADERS = [
  "receivedAt", "id", "playerId", "playedAt", "rounds", "score",
  "presses", "accuracy", "avgReactionMs", "fastestMs", "appVersion"
];
var MAX_BODY_CHARS = 20000;
var MAX_BATCH = 20;
var RATE_LIMIT_PER_HOUR = 120; // records per anonymous player id per hour
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var VERSION_RE = /^[A-Za-z0-9._-]{1,20}$/;
var DAY_MS = 24 * 60 * 60 * 1000;

function isInt_(v, min, max) {
  return typeof v === "number" && isFinite(v) && Math.floor(v) === v && v >= min && v <= max;
}

/** Returns {ok:true,row:[...]} or {ok:false,reason:"..."}. */
function validateRecord_(r, nowMs) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, reason: "not_an_object" };
  if (typeof r.id !== "string" || !UUID_RE.test(r.id)) return { ok: false, reason: "bad_id" };
  if (typeof r.playerId !== "string" || !UUID_RE.test(r.playerId)) return { ok: false, reason: "bad_player_id" };
  if (typeof r.playedAt !== "string" || r.playedAt.length > 40) return { ok: false, reason: "bad_played_at" };
  var ts = Date.parse(r.playedAt);
  if (!isFinite(ts)) return { ok: false, reason: "bad_played_at" };
  if (ts > nowMs + DAY_MS) return { ok: false, reason: "played_at_in_future" };
  if (ts < nowMs - 30 * DAY_MS) return { ok: false, reason: "played_at_too_old" };
  if (!isInt_(r.rounds, 0, 200)) return { ok: false, reason: "bad_rounds" };
  if (!isInt_(r.score, 0, 201000) || r.score % 10 !== 0) return { ok: false, reason: "bad_score" };
  if (r.score > 5 * r.rounds * (r.rounds + 1)) return { ok: false, reason: "score_exceeds_rounds" };
  if (!isInt_(r.presses, 0, 20000) || r.presses < r.rounds) return { ok: false, reason: "bad_presses" };
  if (!isInt_(r.accuracy, 0, 100)) return { ok: false, reason: "bad_accuracy" };
  if (!isInt_(r.avgReactionMs, 0, 60000)) return { ok: false, reason: "bad_avg_reaction" };
  if (!isInt_(r.fastestMs, 0, 60000) || r.fastestMs > r.avgReactionMs) return { ok: false, reason: "bad_fastest" };
  if (typeof r.appVersion !== "string" || !VERSION_RE.test(r.appVersion)) return { ok: false, reason: "bad_app_version" };
  return {
    ok: true,
    row: [
      new Date(nowMs).toISOString(), r.id, r.playerId, new Date(ts).toISOString(),
      r.rounds, r.score, r.presses, r.accuracy, r.avgReactionMs, r.fastestMs, r.appVersion
    ]
  };
}

/**
 * Pure request handler (no Google services), so it can be unit tested.
 * deps = { appendRows(rows), hasId(id) -> bool, rateLimit(playerId) -> bool }
 */
function handlePost_(bodyText, deps, nowMs) {
  if (typeof bodyText !== "string" || bodyText.length === 0 || bodyText.length > MAX_BODY_CHARS) {
    return { ok: false, error: "bad_request" };
  }
  var payload;
  try { payload = JSON.parse(bodyText); } catch (e) { return { ok: false, error: "bad_request" }; }
  var records = payload && payload.records;
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_BATCH) {
    return { ok: false, error: "bad_request" };
  }

  var accepted = [], duplicates = [], rejected = [], rows = [], throttled = 0;
  var seen = {};
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var v = validateRecord_(r, nowMs);
    if (!v.ok) {
      rejected.push({ id: r && typeof r.id === "string" ? r.id.slice(0, 64) : null, reason: v.reason });
      continue;
    }
    if (seen[r.id] || deps.hasId(r.id)) { duplicates.push(r.id); seen[r.id] = true; continue; }
    if (!deps.rateLimit(r.playerId)) { throttled++; continue; }
    seen[r.id] = true;
    rows.push(v.row);
    accepted.push(r.id);
  }
  if (rows.length) deps.appendRows(rows);
  return { ok: true, accepted: accepted, duplicates: duplicates, rejected: rejected, throttled: throttled };
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  ensureHeaders_(sheet);
  return sheet;
}

function realDeps_(sheet) {
  var cache = CacheService.getScriptCache();
  return {
    appendRows: function (rows) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
    },
    hasId: function (id) {
      var last = sheet.getLastRow();
      if (last < 2) return false;
      return sheet.getRange(2, 2, last - 1, 1).createTextFinder(id).matchEntireCell(true).findNext() !== null;
    },
    rateLimit: function (playerId) {
      var key = "rl:" + playerId;
      var count = Number(cache.get(key)) || 0;
      if (count + 1 > RATE_LIMIT_PER_HOUR) return false;
      cache.put(key, String(count + 1), 3600);
      return true;
    }
  };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    lock.waitLock(20000);
    locked = true;
    var body = e && e.postData ? e.postData.contents : "";
    return json_(handlePost_(body, realDeps_(getSheet_()), Date.now()));
  } catch (err) {
    return json_({ ok: false, error: "server_error" });
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (ignore) {} }
  }
}

/** Health check only. Never returns collected data. */
function doGet() {
  return json_({ ok: true, service: "memory-rush-collector" });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    validateRecord_: validateRecord_, handlePost_: handlePost_, ensureHeaders_: ensureHeaders_,
    doPost: doPost, doGet: doGet, HEADERS: HEADERS, MAX_BATCH: MAX_BATCH,
    RATE_LIMIT_PER_HOUR: RATE_LIMIT_PER_HOUR
  };
}
