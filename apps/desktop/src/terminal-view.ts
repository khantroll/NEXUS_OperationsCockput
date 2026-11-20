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

const terminalFont = 'Cascadia Code, Cascadia Mono, DejaVu Sans Mono, Liberation Mono, Consolas, "Courier New", monospace';

/** Real interactive terminal for one attachment: keystrokes go to the PTY, output streams in, size follows the pane. */
export function TerminalView(props: TerminalViewProps): React.JSX.Element {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  const { host, sessionId, attachmentId, initialOutput, writable } = props;

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const terminal = new Terminal({
      cursorBlink: writable,
      cursorInactiveStyle: writable ? "outline" : "none",
      disableStdin: !writable,
      convertEol: true,
      fontFamily: terminalFont,
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      scrollback: 5000,
      theme: { background: "#080d18", foreground: "#d8f5e6", cursor: "#a6f3c5", selectionBackground: "#1a4a3a" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);

    let disposed = false;
    let replayFlushed = false;
    let lastCols = 0;
    let lastRows = 0;
    let frame = 0;

    const flushReplay = (): void => {
      if (replayFlushed) return;
      mounted.add(attachmentId);
      terminal.write(initialOutput);
      for (const chunk of preMount.get(attachmentId)?.chunks ?? []) terminal.write(chunk);
      preMount.delete(attachmentId);
      replayFlushed = true;
    };

    const syncSize = (): void => {
      if (disposed) return;
      try {
        const proposed = fit.proposeDimensions();
        if (!proposed || proposed.cols < 2 || proposed.rows < 1) return;
        fit.fit();
        // Fit first so replay wraps to the real tile size instead of the 80x24 default.
        flushReplay();
        if (!writable || terminal.cols < minCols || terminal.rows < minRows) return;
        if (terminal.cols === lastCols && terminal.rows === lastRows) return;
        lastCols = terminal.cols;
        lastRows = terminal.rows;
        void host.resize(attachmentId, terminal.cols, terminal.rows).catch(() => undefined);
      } catch { /* element not laid out yet */ }
    };
    syncSize();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncSize);
    });
    observer.observe(element);
    if (frameRef.current) observer.observe(frameRef.current);

    const unsubscribe = host.onData((payload) => {
      if (payload.attachmentId === attachmentId) terminal.write(payload.data);
    });

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

    const onWindowResize = (): void => syncSize();
    window.addEventListener("resize", onWindowResize);
    void document.fonts.ready.then(() => { if (!disposed) syncSize(); });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
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
    ref: frameRef,
    "data-terminal-session": sessionId,
    "data-terminal-writable": String(writable),
    style: { flex: 1, minHeight: 0, minWidth: 0, height: "100%", width: "100%", padding: "8px 10px 10px", background: "#080d18", boxSizing: "border-box", overflow: "hidden" },
  }, React.createElement("div", {
    ref: container,
    style: { height: "100%", width: "100%", overflow: "hidden" },
  }));
}
