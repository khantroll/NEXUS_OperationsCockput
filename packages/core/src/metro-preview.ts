export const DEFAULT_PREVIEW_INTERVAL_MS = 3000;
export const MIN_PREVIEW_INTERVAL_MS = 1000;
export const MAX_PREVIEW_INTERVAL_MS = 30_000;
export const DEFAULT_PREVIEW_CONCURRENCY = 2;
export const MIN_PREVIEW_CONCURRENCY = 1;
export const MAX_PREVIEW_CONCURRENCY = 8;
export const DEFAULT_PREVIEW_TEXT_CHARS = 2000;

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function parsePreviewIntervalMs(
  raw: string | undefined,
  fallback = DEFAULT_PREVIEW_INTERVAL_MS,
): number {
  return parseBoundedInt(raw, fallback, MIN_PREVIEW_INTERVAL_MS, MAX_PREVIEW_INTERVAL_MS);
}

export function parsePreviewConcurrency(
  raw: string | undefined,
  fallback = DEFAULT_PREVIEW_CONCURRENCY,
): number {
  return parseBoundedInt(raw, fallback, MIN_PREVIEW_CONCURRENCY, MAX_PREVIEW_CONCURRENCY);
}

export function shouldCapturePreview(input: {
  now: number;
  lastCaptureAt: number | undefined;
  intervalMs: number;
  paused: boolean;
  windowHidden: boolean;
}): boolean {
  if (input.paused || input.windowHidden) return false;
  if (input.lastCaptureAt === undefined) return true;
  return input.now - input.lastCaptureAt >= input.intervalMs;
}

/**
 * Parked tiles eligible for a live snapshot. Caller supplies priority order
 * (typically current-workspace shelf order). Everyone else uses the last
 * static snapshot, or a placeholder if none exists yet.
 */
export function livePreviewSet(
  parkedPanelIds: readonly string[],
  cap: number,
  options: { paused: boolean; windowHidden: boolean },
): string[] {
  if (options.paused || options.windowHidden || cap <= 0) return [];
  return parkedPanelIds.slice(0, cap);
}

/** Panel IDs whose snapshots should be refreshed on this tick. */
export function tickPreviewScheduler(input: {
  parkedPanelIds: readonly string[];
  lastCaptureAt: ReadonlyMap<string, number>;
  now: number;
  intervalMs: number;
  cap: number;
  paused: boolean;
  windowHidden: boolean;
}): string[] {
  const live = livePreviewSet(input.parkedPanelIds, input.cap, input);
  return live.filter((panelId) => shouldCapturePreview({
    now: input.now,
    lastCaptureAt: input.lastCaptureAt.get(panelId),
    intervalMs: input.intervalMs,
    paused: input.paused,
    windowHidden: input.windowHidden,
  }));
}

export function appendPreviewText(current: string, chunk: string, capChars = DEFAULT_PREVIEW_TEXT_CHARS): string {
  const next = current + chunk;
  return next.length <= capChars ? next : next.slice(next.length - capChars);
}

export function summarizePreviewCost(durationsMs: readonly number[]): {
  count: number;
  averageMs: number;
  maxMs: number;
} {
  if (durationsMs.length === 0) return { count: 0, averageMs: 0, maxMs: 0 };
  let total = 0;
  let maxMs = 0;
  for (const duration of durationsMs) {
    total += duration;
    if (duration > maxMs) maxMs = duration;
  }
  return { count: durationsMs.length, averageMs: total / durationsMs.length, maxMs };
}
