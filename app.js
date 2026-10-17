/* UI glue: DOM, audio, timing, localStorage. Logic lives in game.js and collector.js */
(function () {
  "use strict";
  const { createGame, playbackDelay, updateHighScore } = window.MemoryRush;
  const cfg = window.MEMORY_RUSH_CONFIG || {};
  const STORE_BEST = "memoryRush.best";
  const STORE_HISTORY = "memoryRush.history";

  const $ = (id) => document.getElementById(id);
  const pads = Array.from(document.querySelectorAll(".pad"));
  const board = $("board");
  const el = {
    round: $("round"), score: $("score"), best: $("best"), msg: $("message"),
    start: $("start"), results: $("results"), exp: $("export"), saveStatus: $("save-status"),
    rRounds: $("r-rounds"), rAcc: $("r-acc"), rAvg: $("r-avg"), rFast: $("r-fast"),
  };

  let store = null;
  try { store = window.localStorage; } catch (e) { store = null; }

  const game = createGame();
  const collector = window.MemoryRushCollector.createCollector({
    endpoint: cfg.endpoint,
    appVersion: cfg.appVersion,
    storage: store,
  });

  const FREQ = [261.6, 329.6, 392.0, 523.3];
  let audioCtx = null;
  let lastCueAt = 0;
  let runToken = 0; // invalidates in-flight playback if a new game starts

  function safeGet(key) { try { return store ? store.getItem(key) : null; } catch (e) { return null; } }
  function safeSet(key, val) { try { if (store) store.setItem(key, val); } catch (e) { /* private mode */ } }

  function beep(i) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = FREQ[i]; o.type = "sine";
      g.gain.setValueAtTime(0.15, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.26);
    } catch (e) { /* audio is optional */ }
  }

  function flash(i, ms) {
    pads[i].classList.add("lit"); beep(i);
    setTimeout(() => pads[i].classList.remove("lit"), ms);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function render() {
    const s = game.state;
    el.round.textContent = s.round;
    el.score.textContent = s.score;
  }

  function lock(on) { board.classList.toggle("locked", on); }

  async function playRound(seq) {
    const token = runToken;
    lock(true);
    el.msg.textContent = "Watch…";
    await sleep(500);
    const d = playbackDelay(game.state.round);
    for (const i of seq) {
      if (token !== runToken) return;
      flash(i, d * 0.6);
      await sleep(d);
    }
    if (token !== runToken) return;
    game.beginInput();
    lastCueAt = performance.now();
    lock(false);
    el.msg.textContent = "Your turn!";
  }

  function onPad(i) {
    const now = performance.now();
    const res = game.press(i, now - lastCueAt);
    if (res.result === "ignored") return;
    lastCueAt = now;
    flash(i, 150);

    if (res.result === "wrong") return gameOver();
    if (res.result === "round-complete") {
      render();
      el.msg.textContent = "Nice!";
      setTimeout(() => playRound(game.nextRound()), 600);
    }
  }

  // ---- data sharing (consent-gated, offline-safe) ----
  function safeFlush() { return collector.flush().catch(() => ({ status: "error", remaining: collector.pending() })); }

  function describeFlush(r) {
    if (!r || r.status === "disabled") return "";
    if (r.status === "ok") return r.remaining === 0 ? "Result shared ✓" : "";
    if (r.status === "offline") return "Saved on your device. It will be sent when you're back online.";
    if (r.status === "busy") return "Sending…";
    return "Saved on your device. We'll retry automatically.";
  }

  function flushAndShow() {
    if (collector.consent() !== "granted") return Promise.resolve();
    el.saveStatus.textContent = "Sending…";
    return safeFlush().then((r) => { el.saveStatus.textContent = describeFlush(r); });
  }

  function gameOver() {
    lock(true);
    runToken++;
    const st = game.stats();
    const best = updateHighScore(safeGet(STORE_BEST), st.score);
    safeSet(STORE_BEST, String(best));
    el.best.textContent = best;
    el.msg.textContent = "Game over — press Start to retry";
    el.start.textContent = "Play again";
    el.start.disabled = false;

    el.rRounds.textContent = st.rounds;
    el.rAcc.textContent = st.accuracy;
    el.rAvg.textContent = st.avgReactionMs;
    el.rFast.textContent = st.fastestMs;
    el.results.hidden = false;
    el.saveStatus.textContent = "";

    let history = [];
    try { history = JSON.parse(safeGet(STORE_HISTORY) || "[]"); } catch (e) { history = []; }
    if (!Array.isArray(history)) history = [];
    history.push({ playedAt: new Date().toISOString(), ...st });
    safeSet(STORE_HISTORY, JSON.stringify(history.slice(-200)));

    if (collector.record(st)) flushAndShow();
  }

  function startGame() {
    runToken++;
    el.start.disabled = true;
    el.results.hidden = true;
    const seq = game.start();
    render();
    playRound(seq);
  }

  function exportCsv() {
    let history = [];
    try { history = JSON.parse(safeGet(STORE_HISTORY) || "[]"); } catch (e) { /* ignore */ }
    const cols = ["playedAt", "rounds", "score", "presses", "accuracy", "avgReactionMs", "fastestMs"];
    const rows = [cols.join(",")].concat(history.map((h) => cols.map((c) => h[c]).join(",")));
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "memory-rush-history.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function share() {
    const url = location.href.split("#")[0];
    const best = Number(safeGet(STORE_BEST)) || 0;
    const text = best ? "I scored " + best + " in Memory Rush. Can you beat it?" : "Try Memory Rush, it's free!";
    if (navigator.share) {
      navigator.share({ title: "Memory Rush", text: text, url: url }).catch(function () {});
    } else {
      window.open("https://wa.me/?text=" + encodeURIComponent(text + " " + url), "_blank", "noopener");
    }
  }

  // ---- consent + privacy dialogs ----
  function showModal(id, on) { $(id).hidden = !on; }

  function renderPrivacy() {
    const on = collector.consent() === "granted";
    $("privacy-status").textContent = on
      ? "Sharing is ON: your anonymous results are sent to the study."
      : "Sharing is OFF: nothing is sent. Your results stay on this device.";
    $("privacy-id").textContent = on && collector.playerId() ? collector.playerId() : "none";
    $("privacy-toggle").textContent = on ? "Stop sharing" : "Turn sharing on";
  }

  function initCollection() {
    if (!collector.enabled()) return;
    $("privacy-open").hidden = false;
    if (collector.needsConsent()) {
      el.start.disabled = true;
      showModal("consent", true);
    } else {
      safeFlush(); // send anything left over from an earlier offline session
    }
  }

  $("consent-yes").addEventListener("click", () => {
    collector.setConsent("granted");
    showModal("consent", false);
    el.start.disabled = false;
    safeFlush();
  });
  $("consent-no").addEventListener("click", () => {
    collector.setConsent("declined");
    showModal("consent", false);
    el.start.disabled = false;
  });
  $("privacy-open").addEventListener("click", () => { renderPrivacy(); showModal("privacy", true); });
  $("privacy-close").addEventListener("click", () => showModal("privacy", false));
  $("privacy-toggle").addEventListener("click", () => {
    if (collector.consent() === "granted") collector.revoke();
    else { collector.setConsent("granted"); safeFlush(); }
    renderPrivacy();
  });

  window.addEventListener("online", safeFlush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") safeFlush(); });

  pads.forEach((p) => p.addEventListener("pointerdown", (e) => { e.preventDefault(); onPad(Number(p.dataset.pad)); }));
  document.addEventListener("keydown", (e) => {
    const map = { "1": 0, "2": 1, "3": 2, "4": 3 };
    if (e.key in map) onPad(map[e.key]);
  });
  $("share").addEventListener("click", share);
  el.start.addEventListener("click", startGame);
  el.exp.addEventListener("click", exportCsv);

  el.best.textContent = Number(safeGet(STORE_BEST)) || 0;
  lock(true);
  initCollection();
})();
