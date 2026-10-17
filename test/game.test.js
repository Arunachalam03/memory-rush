"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createGame, mulberry32, playbackDelay, updateHighScore } = require("../game.js");

const seeded = () => createGame({ rng: mulberry32(42) });

test("start creates a 1-step sequence in 'showing' state", () => {
  const g = seeded();
  const seq = g.start();
  assert.equal(seq.length, 1);
  assert.equal(g.state.status, "showing");
  assert.equal(g.state.round, 1);
});

test("sequence values always within pad range", () => {
  const g = createGame({ rng: () => 0.999999 });
  g.start();
  for (let i = 0; i < 50; i++) g.nextRound();
  assert.ok(g.state.sequence.every((p) => p >= 0 && p <= 3));
});

test("same seed gives same sequence (deterministic)", () => {
  const a = seeded(), b = seeded();
  a.start(); b.start();
  for (let i = 0; i < 5; i++) { a.nextRound(); b.nextRound(); }
  assert.deepEqual(a.state.sequence, b.state.sequence);
});

test("presses are ignored before input phase", () => {
  const g = seeded();
  g.start();
  assert.equal(g.press(0, 100).result, "ignored");
  assert.equal(g.state.presses, 0);
});

test("invalid pad values are ignored", () => {
  const g = seeded();
  g.start(); g.beginInput();
  for (const bad of [-1, 4, 1.5, NaN, "1", null, undefined]) {
    assert.equal(g.press(bad, 100).result, "ignored");
  }
  assert.equal(g.state.status, "input");
});

test("correct press then round completes and scores round*10", () => {
  const g = seeded();
  const seq = g.start(); g.beginInput();
  const r = g.press(seq[0], 300);
  assert.equal(r.result, "round-complete");
  assert.equal(g.state.score, 10);
});

test("multi-step round: 'correct' until last step", () => {
  const g = seeded();
  g.start(); g.beginInput();
  g.press(g.state.sequence[0], 200);
  const seq2 = g.nextRound(); g.beginInput();
  assert.equal(g.press(seq2[0], 200).result, "correct");
  assert.equal(g.press(seq2[1], 200).result, "round-complete");
  assert.equal(g.state.score, 10 + 20);
});

test("wrong press ends the game and reports expected pad", () => {
  const g = seeded();
  const seq = g.start(); g.beginInput();
  const wrong = (seq[0] + 1) % 4;
  const r = g.press(wrong, 250);
  assert.equal(r.result, "wrong");
  assert.equal(r.expected, seq[0]);
  assert.equal(g.state.status, "over");
  assert.equal(g.press(seq[0], 100).result, "ignored");
  assert.equal(g.nextRound(), null);
});

test("stats: accuracy, average and fastest reaction", () => {
  const g = seeded();
  g.start(); g.beginInput();
  const s1 = g.state.sequence[0];
  g.press(s1, 300);                       // correct
  const seq2 = g.nextRound(); g.beginInput();
  g.press(seq2[0], 100);                  // correct
  g.press((seq2[1] + 1) % 4, 200);        // wrong
  const st = g.stats();
  assert.equal(st.presses, 3);
  assert.equal(st.accuracy, 67);
  assert.equal(st.avgReactionMs, 200);
  assert.equal(st.fastestMs, 100);
  assert.equal(st.rounds, 1);
});

test("stats on a fresh game are zeros, not NaN", () => {
  const st = seeded().stats();
  assert.deepEqual(st, { rounds: 0, score: 0, presses: 0, accuracy: 0, avgReactionMs: 0, fastestMs: 0 });
});

test("bad reaction values are not recorded", () => {
  const g = seeded();
  g.start(); g.beginInput();
  g.press(g.state.sequence[0], -5);
  assert.equal(g.state.reactions.length, 0);
});

test("restart fully resets state", () => {
  const g = seeded();
  g.start(); g.beginInput(); g.press((g.state.sequence[0] + 1) % 4, 100);
  g.start();
  assert.equal(g.state.score, 0);
  assert.equal(g.state.sequence.length, 1);
  assert.equal(g.state.reactions.length, 0);
  assert.equal(g.state.status, "showing");
});

test("playbackDelay speeds up and respects floor", () => {
  assert.equal(playbackDelay(1), 700);
  assert.ok(playbackDelay(5) < playbackDelay(1));
  assert.equal(playbackDelay(100), 250);
});

test("updateHighScore keeps the max and tolerates junk", () => {
  assert.equal(updateHighScore(null, 50), 50);
  assert.equal(updateHighScore("80", 50), 80);
  assert.equal(updateHighScore("abc", 30), 30);
  assert.equal(updateHighScore(undefined, NaN), 0);
});
