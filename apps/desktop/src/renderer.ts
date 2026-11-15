import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { CommandEnvelope, PanelCommand, PanelRecord } from "../../../packages/contracts/src/index.js";
import { applyPanelCommand } from "../../../packages/core/src/lifecycle.js";

declare global {
  interface Window {
    nexusShell: { version: string; capabilities: string[] };
  }
}

const initialPanel: PanelRecord = {
  panelId: "demo-panel",
  sessionId: "demo-session",
  workspaceId: "default",
  placement: "docked",
  homeAnchor: {
    workspaceId: "default",
    groupId: "terminals",
    splitPath: ["root", "center"],
    tabIndex: 0,
    fallbackZone: "center",
    layoutRevision: 1,
  },
  revision: 1,
};

function command(panel: PanelRecord, payload: PanelCommand): CommandEnvelope<PanelCommand> {
  return {
    requestId: crypto.randomUUID(),
    actorId: "desktop-operator",
    expectedRevision: panel.revision,
    payload,
  };
}

function App(): React.JSX.Element {
  const [panel, setPanel] = useState(initialPanel);
  const dispatch = (payload: PanelCommand): void => {
    const transition = applyPanelCommand(panel, command(panel, payload));
    if (transition.result.accepted) setPanel(transition.record);
  };

  return React.createElement(
    "main",
    { style: styles.app },
    React.createElement(
      "header",
      { style: styles.header },
      React.createElement("div", null,
        React.createElement("div", { style: styles.eyebrow }, "NEXUS OPERATIONS COCKPIT"),
        React.createElement("h1", { style: styles.title }, "Command workspace"),
      ),
      React.createElement("span", { style: styles.badge }, window.nexusShell.version),
    ),
    React.createElement(
      "section",
      { style: styles.workspace },
      React.createElement("aside", { style: styles.shelf },
        React.createElement("div", { style: styles.sectionLabel }, "SESSION SHELF"),
        React.createElement("div", { style: styles.sessionCard },
          React.createElement("strong", null, "Presentation demo"),
          React.createElement("span", { style: styles.muted }, "session · "+panel.sessionId),
          React.createElement("span", { style: styles.running }, "● local shell state"),
        ),
      ),
      React.createElement("section", { style: styles.canvas },
        React.createElement("div", { style: styles.sectionLabel }, "WORKSPACE / DEFAULT"),
        React.createElement("article", { style: styles.panel },
          React.createElement("div", { style: styles.panelHeader },
            React.createElement("div", null,
              React.createElement("strong", null, "Terminal presentation"),
              React.createElement("div", { style: styles.muted }, "presentation state: "+panel.placement),
            ),
            React.createElement("span", { style: styles.revision }, "rev "+panel.revision),
          ),
          React.createElement("pre", { style: styles.terminal }, "$ nexus presentation\n> sessionId: "+panel.sessionId+"\n> host-agent IPC is not connected in this shell spike"),
          React.createElement("div", { style: styles.controls },
            React.createElement("button", { onClick: () => dispatch({ op: "park", panelId: panel.panelId }) }, "Park"),
            React.createElement("button", { onClick: () => dispatch({ op: "summon", panelId: panel.panelId, targetSurface: "main" }) }, "Summon"),
            React.createElement("button", { onClick: () => dispatch({ op: "snapBack", panelId: panel.panelId }) }, "SnapBack"),
          ),
        ),
      ),
    ),
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: { minHeight: "100vh", padding: "28px 34px", boxSizing: "border-box", background: "#0b1020", color: "#e8ecf7", fontFamily: "Inter, Segoe UI, sans-serif" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28 },
  eyebrow: { color: "#7c8cff", fontSize: 11, letterSpacing: 2.2, fontWeight: 700 },
  title: { margin: "7px 0 0", fontSize: 30, letterSpacing: -0.8 },
  badge: { color: "#aab5cc", border: "1px solid #293454", borderRadius: 999, padding: "7px 11px", fontSize: 12 },
  workspace: { display: "grid", gridTemplateColumns: "250px 1fr", gap: 18, minHeight: 620 },
  shelf: { background: "#11182b", border: "1px solid #202b48", borderRadius: 14, padding: 18 },
  sectionLabel: { color: "#7380a1", fontSize: 10, letterSpacing: 1.8, fontWeight: 700, marginBottom: 14 },
  sessionCard: { display: "grid", gap: 7, padding: 13, borderRadius: 10, background: "#17213a", border: "1px solid #334266" },
  muted: { color: "#8491b0", fontSize: 12 },
  running: { color: "#61d6a2", fontSize: 12 },
  canvas: { background: "#0e1527", border: "1px solid #202b48", borderRadius: 14, padding: 22 },
  panel: { maxWidth: 780, background: "#11182b", border: "1px solid #2b385b", borderRadius: 12, overflow: "hidden", boxShadow: "0 14px 50px #05081480" },
  panelHeader: { display: "flex", justifyContent: "space-between", padding: "16px 18px", borderBottom: "1px solid #202b48" },
  revision: { color: "#7180a5", fontSize: 12 },
  terminal: { margin: 0, minHeight: 220, padding: 20, color: "#a6f3c5", background: "#080d18", fontFamily: "Cascadia Code, Consolas, monospace", lineHeight: 1.7, fontSize: 13 },
  controls: { display: "flex", gap: 8, padding: 14 },
};

createRoot(document.getElementById("root")!).render(React.createElement(App));
