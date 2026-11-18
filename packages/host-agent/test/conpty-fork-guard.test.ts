import assert from "node:assert/strict";
import test from "node:test";
import { envWithoutTestContext, sanitizeExecArgv } from "../src/conpty-fork-guard.js";

test("sanitizeExecArgv strips test-runner flags and keeps runtime flags", () => {
  assert.deepEqual(
    sanitizeExecArgv([
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      "--test-isolation=process",
      "--experimental-test-isolation",
      "--watch",
      "--enable-source-maps",
    ]),
    ["--enable-source-maps"],
  );
  assert.deepEqual(sanitizeExecArgv([]), []);
});

test("envWithoutTestContext drops NODE_TEST_CONTEXT and leaves other values", () => {
  assert.deepEqual(
    envWithoutTestContext({ NODE_TEST_CONTEXT: "1", PATH: "/bin", HOME: "/tmp" }),
    { PATH: "/bin", HOME: "/tmp" },
  );
});
