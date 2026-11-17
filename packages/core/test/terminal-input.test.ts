import assert from "node:assert/strict";
import test from "node:test";
import { chunkTerminalInput, maxTerminalWrite } from "../src/terminal-input.js";

test("short input is one piece and empty input is none", () => {
  assert.deepEqual(chunkTerminalInput("ls -la\r"), ["ls -la\r"]);
  assert.deepEqual(chunkTerminalInput(""), []);
});

test("long input is split in order into pieces no larger than the limit and rejoins exactly", () => {
  const data = "abcdefghij".repeat(1000) + "tail";
  const pieces = chunkTerminalInput(data);
  assert.ok(pieces.length > 2);
  assert.ok(pieces.every((piece) => piece.length <= maxTerminalWrite));
  assert.equal(pieces.join(""), data);
});

test("a surrogate pair is never split across pieces", () => {
  const emoji = "\u{1F600}"; // two UTF-16 units
  for (const size of [2, 3, 4, 5, 7]) {
    const data = "a" + emoji.repeat(10) + "b";
    const pieces = chunkTerminalInput(data, size);
    assert.equal(pieces.join(""), data, "size " + size);
    for (const piece of pieces) {
      assert.ok(!/[\ud800-\udbff]$/.test(piece), "piece ends in a lone high surrogate at size " + size);
      assert.ok(!/^[\udc00-\udfff]/.test(piece), "piece starts with a lone low surrogate at size " + size);
    }
  }
});

test("invalid chunk sizes are rejected", () => {
  assert.throws(() => chunkTerminalInput("x", 1), RangeError);
  assert.throws(() => chunkTerminalInput("x", 2.5), RangeError);
});
