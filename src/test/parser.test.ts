import { test } from "node:test";
import assert from "node:assert/strict";
import { parseZshHistory, parseBashHistory } from "../indexer.js";

test("zsh extended history parses ts + duration + cmd", () => {
  const text = ": 1700000000:5;git status\n: 1700000010:0;ls -la\n";
  const rows = parseZshHistory(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cmd, "git status");
  assert.equal(rows[0].ts, 1700000000000);
  assert.equal(rows[0].duration_ms, 5000);
  assert.equal(rows[0].shell, "zsh");
});

test("zsh history line continuation joins backslash-newline", () => {
  const text = ": 1700000000:0;echo line1 \\\nline2\n";
  const rows = parseZshHistory(text);
  assert.equal(rows.length, 1);
  assert.match(rows[0].cmd, /line1/);
  assert.match(rows[0].cmd, /line2/);
});

test("zsh plain history (no extended format) still parses", () => {
  const text = "git pull\nls\n";
  const rows = parseZshHistory(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cmd, "git pull");
  assert.equal(rows[0].ts, null);
});

test("bash history with timestamps", () => {
  const text = "#1700000000\ngit status\n#1700000010\nls -la\n";
  const rows = parseBashHistory(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cmd, "git status");
  assert.equal(rows[0].ts, 1700000000000);
  assert.equal(rows[0].shell, "bash");
});

test("bash history without timestamps", () => {
  const text = "git pull\nls\n";
  const rows = parseBashHistory(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ts, null);
});
