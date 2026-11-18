import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PREVIEW_CONCURRENCY,
  DEFAULT_PREVIEW_INTERVAL_MS,
  MAX_PREVIEW_CONCURRENCY,
  MAX_PREVIEW_INTERVAL_MS,
  MIN_PREVIEW_CONCURRENCY,
  MIN_PREVIEW_INTERVAL_MS,
  appendPreviewText,
  livePreviewSet,
  parsePreviewConcurrency,
  parsePreviewIntervalMs,
  shouldCapturePreview,
  summarizePreviewCost,
  tickPreviewScheduler,
} from "../src/metro-preview.js";

test("parsePreviewIntervalMs and parsePreviewConcurrency clamp and fall back", () => {
  assert.equal(parsePreviewIntervalMs(undefined), DEFAULT_PREVIEW_INTERVAL_MS);
  assert.equal(parsePreviewIntervalMs("  "), DEFAULT_PREVIEW_INTERVAL_MS);
  assert.equal(parsePreviewIntervalMs("nope"), DEFAULT_PREVIEW_INTERVAL_MS);
  assert.equal(parsePreviewIntervalMs("1500"), 1500);
  assert.equal(parsePreviewIntervalMs("250"), MIN_PREVIEW_INTERVAL_MS);
  assert.equal(parsePreviewIntervalMs("99999"), MAX_PREVIEW_INTERVAL_MS);
  assert.equal(parsePreviewConcurrency(undefined), DEFAULT_PREVIEW_CONCURRENCY);
  assert.equal(parsePreviewConcurrency("3"), 3);
  assert.equal(parsePreviewConcurrency("0"), MIN_PREVIEW_CONCURRENCY);
  assert.equal(parsePreviewConcurrency("99"), MAX_PREVIEW_CONCURRENCY);
});

test("shouldCapturePreview pauses when hidden and respects the interval", () => {
  assert.equal(shouldCapturePreview({ now: 10, lastCaptureAt: undefined, intervalMs: 3000, paused: false, windowHidden: false }), true);
  assert.equal(shouldCapturePreview({ now: 10, lastCaptureAt: undefined, intervalMs: 3000, paused: true, windowHidden: false }), false);
  assert.equal(shouldCapturePreview({ now: 10, lastCaptureAt: undefined, intervalMs: 3000, paused: false, windowHidden: true }), false);
  assert.equal(shouldCapturePreview({ now: 2999, lastCaptureAt: 0, intervalMs: 3000, paused: false, windowHidden: false }), false);
  assert.equal(shouldCapturePreview({ now: 3000, lastCaptureAt: 0, intervalMs: 3000, paused: false, windowHidden: false }), true);
});

test("livePreviewSet caps concurrent live previews and yields none while paused", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(livePreviewSet(ids, 2, { paused: false, windowHidden: false }), ["a", "b"]);
  assert.deepEqual(livePreviewSet(ids, 8, { paused: false, windowHidden: false }), ids);
  assert.deepEqual(livePreviewSet(ids, 2, { paused: true, windowHidden: false }), []);
  assert.deepEqual(livePreviewSet(ids, 2, { paused: false, windowHidden: true }), []);
});

test("tickPreviewScheduler only refreshes due live-set tiles", () => {
  const lastCaptureAt = new Map<string, number>([["a", 0], ["b", 0]]);
  assert.deepEqual(tickPreviewScheduler({
    parkedPanelIds: ["a", "b", "c"],
    lastCaptureAt,
    now: 1000,
    intervalMs: 3000,
    cap: 2,
    paused: false,
    windowHidden: false,
  }), []);
  assert.deepEqual(tickPreviewScheduler({
    parkedPanelIds: ["a", "b", "c"],
    lastCaptureAt,
    now: 3000,
    intervalMs: 3000,
    cap: 2,
    paused: false,
    windowHidden: false,
  }), ["a", "b"]);
  assert.deepEqual(tickPreviewScheduler({
    parkedPanelIds: ["a", "b", "c"],
    lastCaptureAt: new Map(),
    now: 0,
    intervalMs: 3000,
    cap: 2,
    paused: false,
    windowHidden: false,
  }), ["a", "b"]);
});

test("appendPreviewText keeps a bounded trailing snapshot", () => {
  assert.equal(appendPreviewText("ab", "cd", 10), "abcd");
  assert.equal(appendPreviewText("abcd", "efghij", 8), "cdefghij");
});

test("summarizePreviewCost reports average and max capture duration", () => {
  assert.deepEqual(summarizePreviewCost([]), { count: 0, averageMs: 0, maxMs: 0 });
  assert.deepEqual(summarizePreviewCost([10, 20, 30]), { count: 3, averageMs: 20, maxMs: 30 });
});
