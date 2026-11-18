import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { chunkTerminalInput } from "../../../packages/core/src/terminal-input.js";

/** The slice of the preload bridge a terminal needs; passed in so this file has no `window` coupling. */
export interface TerminalHost {
  onData(listener: (payload: { attachmentId: string; data: string }) => void): () => void;
  write(attachmentId: string, data: string): Promise<void>;
  /** Resize is keyed on the attachment (not the session) so only the owning, writable view can do it. */
  resize(attachmentId: string, cols: number, rows: number): Promise<void>;
}

export interface TerminalViewProps {
  host: TerminalHost;
  sessionId: string;
  attachmentId: string;
  /** Replay captured at attach time (raw PTY output, escape sequences included). */
  initialOutput: string;
  /** A read attachment cannot write; keystrokes are then ignored and the cursor is hidden. */
  writable: boolean;
}

const minCols = 20; // mirrors PtySupervisor.resize bounds so the PTY and xterm never disagree
const minRows = 5;
const preMountCapChars = 512 * 1024;

// Output that arrives for an attachment before its terminal exists (between the attach reply and the
// first render) is held here, in order and unmodified, then flushed into xterm at mount. Nothing is
// truncated mid-escape: when over the cap, whole oldest chunks are dropped.
const preMount = new Map<string, { chunks: string[]; chars: number }>();
const mounted = new Set<string>();

/** Feed every `nexus:host:data` payload here once, at app level. */
export function routeTerminalData(payload: { attachmentId: string; data: string }): void {
  if (mounted.has(payload.attachmentId)) return; // the live terminal has its own subscription
  const entry = preMount.get(payload.attachmentId) ?? { chunks: [], chars: 0 };
  entry.chunks.push(payload.data);
  entry.chars += payload.data.length;
  while (entry.chars > preMountCapChars && entry.chunks.length > 1) entry.chars -= entry.chunks.shift()?.length ?? 0;
  preMount.set(payload.attachmentId, entry);
}

/** Drop any held output for an attachment that will never get a terminal. */
export function discardTerminalBuffer(attachmentId: string): void {
  preMount.delete(attachmentId);
}

/** Real interactive terminal for one attachment: keystrokes go to the PTY, output streams in, size follows the pane. */
export function TerminalView(props: TerminalViewProps): React.JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const { host, sessionId, attachmentId, initialOutput, writable } = props;

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const terminal = new Terminal({
      cursorBlink: writable,
      cursorInactiveStyle: writable ? "outline" : "none",
      disableStdin: !writable,
      fontFamily: "Cascadia Code, Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: { background: "#080d18", foreground: "#d8f5e6", cursor: "#a6f3c5" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);

    // Synchronous handoff (no await between these steps), so no chunk can fall into a gap: replay, then
    // anything buffered since the attach reply, then live subscription.
    mounted.add(attachmentId);
    terminal.write(initialOutput);
    for (const chunk of preMount.get(attachmentId)?.chunks ?? []) terminal.write(chunk);
    preMount.delete(attachmentId);
    const unsubscribe = host.onData((payload) => {
      if (payload.attachmentId === attachmentId) terminal.write(payload.data);
    });

    let disposed = false;
    let frame = 0;
    const syncSize = (): void => {
      if (disposed) return;
      try {
        fit.fit();
        if (!writable || terminal.cols < minCols || terminal.rows < minRows) return;
        void host.resize(attachmentId, terminal.cols, terminal.rows).catch(() => undefined);
      } catch { /* element not laid out yet */ }
    };
    syncSize();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncSize);
    });
    observer.observe(element);

    // One ordered queue per terminal: a long paste is never interleaved with later keystrokes.
    let queue: Promise<void> = Promise.resolve();
    const input = terminal.onData((data) => {
      if (!writable) return;
      queue = queue.then(async () => {
        for (const piece of chunkTerminalInput(data)) {
          try {
            await host.write(attachmentId, piece);
          } catch {
            return;
          }
        }
      });
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe();
      input.dispose();
      mounted.delete(attachmentId);
      preMount.delete(attachmentId);
      terminal.dispose();
    };
    // A new attachment (restart/reattach) remounts via the caller's key; props are otherwise stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentId]);

  return React.createElement("div", {
    ref: container,
    "data-terminal-session": sessionId,
    "data-terminal-writable": String(writable),
    style: { height: 320, padding: 8, background: "#080d18", boxSizing: "border-box" },
  });
}
