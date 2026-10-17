/* Pure game logic: no DOM, fully unit-testable. Works in browser and Node. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MemoryRush = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_PADS = 4;

  // Small seedable RNG so tests are deterministic.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Playback gets faster as rounds increase, with a floor.
  function playbackDelay(round) {
    return Math.max(250, 700 - (round - 1) * 30);
  }

  function createGame(options) {
    const opts = options || {};
    const rng = opts.rng || Math.random;
    const pads = opts.pads || DEFAULT_PADS;

    const state = {
      status: "idle", // idle | showing | input | over
      sequence: [],
      inputIndex: 0,
      round: 0,
      score: 0,
      presses: 0,
      correct: 0,
      reactions: [],
    };

    function start() {
      state.status = "idle";
      state.sequence = [];
      state.inputIndex = 0;
      state.round = 0;
      state.score = 0;
      state.presses = 0;
      state.correct = 0;
      state.reactions = [];
      return nextRound();
    }

    function nextRound() {
      if (state.status === "over") return null;
      state.sequence.push(Math.min(pads - 1, Math.floor(rng() * pads)));
      state.round = state.sequence.length;
      state.inputIndex = 0;
      state.status = "showing";
      return state.sequence.slice();
    }

    function beginInput() {
      if (state.status !== "showing") return false;
      state.status = "input";
      state.inputIndex = 0;
      return true;
    }

    // reactionMs = time since previous cue/press (measured by the UI).
    function press(pad, reactionMs) {
      if (state.status !== "input") return { result: "ignored" };
      if (!Number.isInteger(pad) || pad < 0 || pad >= pads) return { result: "ignored" };

      state.presses += 1;
      if (typeof reactionMs === "number" && reactionMs >= 0 && isFinite(reactionMs)) {
        state.reactions.push(reactionMs);
      }

      if (pad !== state.sequence[state.inputIndex]) {
        state.status = "over";
        return { result: "wrong", expected: state.sequence[state.inputIndex] };
      }

      state.correct += 1;
      state.inputIndex += 1;

      if (state.inputIndex === state.sequence.length) {
        state.score += state.round * 10;
        state.status = "showing"; // caller calls nextRound()
        return { result: "round-complete", score: state.score };
      }
      return { result: "correct" };
    }

    function stats() {
      const r = state.reactions;
      const sum = r.reduce((a, b) => a + b, 0);
      return {
        rounds: Math.max(0, state.round - (state.status === "over" ? 1 : 0)),
        score: state.score,
        presses: state.presses,
        accuracy: state.presses ? Math.round((state.correct / state.presses) * 100) : 0,
        avgReactionMs: r.length ? Math.round(sum / r.length) : 0,
        fastestMs: r.length ? Math.round(Math.min.apply(null, r)) : 0,
      };
    }

    return {
      start, nextRound, beginInput, press, stats,
      get state() { return state; },
    };
  }

  // Keeps only the best score; tolerant to bad stored values.
  function updateHighScore(previous, score) {
    const prev = Number(previous);
    const base = Number.isFinite(prev) && prev > 0 ? prev : 0;
    return Math.max(base, Number.isFinite(score) ? score : 0);
  }

  return { createGame, mulberry32, playbackDelay, updateHighScore, DEFAULT_PADS };
});
