import assert from "node:assert/strict";
import test from "node:test";

import { cleanLines, stripAnsi } from "../pty.js";

test("stripAnsi: strips CSI/OSC sequences", () => {
  assert.equal(stripAnsi("\x1b[32mgreen\x1b[0m"), "green");
  assert.equal(stripAnsi("\x1b]0;title\x07text"), "text");
});

test("stripAnsi: preserves cursor-forward spacing for ANSI CSI", () => {
  const input = "\x1b[1CYes,\x1b[2CI\x1b[1Caccept";
  assert.equal(stripAnsi(input), " Yes,  I accept");
});

test("stripAnsi: preserves cursor-forward spacing for orphaned CSI", () => {
  const input = "[1CYes,[2CI[1Caccept";
  assert.equal(stripAnsi(input), " Yes,  I accept");
});

test("cleanLines: strips ANSI and keeps non-empty lines", () => {
  const lines = cleanLines("\x1b[32mline-1\x1b[0m\n\nline-2\n");
  assert.deepEqual(lines, ["line-1", "line-2"]);
});
