import { appendPreviewText } from "../../../packages/core/src/metro-preview.js";

const buffers = new Map<string, string>();

export function seedPanelPreview(panelId: string, text: string): void {
  if (buffers.has(panelId) || text.length === 0) return;
  buffers.set(panelId, appendPreviewText("", text));
}

export function appendPanelPreview(panelId: string, chunk: string): void {
  if (chunk.length === 0) return;
  buffers.set(panelId, appendPreviewText(buffers.get(panelId) ?? "", chunk));
}

export function readPanelPreview(panelId: string): string {
  return buffers.get(panelId) ?? "";
}
