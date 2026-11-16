import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistry } from "../src/provider.js";

test("provider registry is deterministic and stores capability metadata only", () => {
  const registry = new ProviderRegistry();
  registry.register({ providerId: "gemini-web", kind: "gemini", displayName: "Gemini", launchMode: "browser", capabilities: ["chat"] });
  registry.register({ providerId: "ssh", kind: "ssh", displayName: "SSH", launchMode: "native", capabilities: ["terminal", "remote"] });
  assert.deepEqual(registry.list().map(({ providerId }) => providerId), ["gemini-web", "ssh"]);
  assert.deepEqual(registry.get("ssh"), {
    providerId: "ssh", kind: "ssh", displayName: "SSH", launchMode: "native", capabilities: ["terminal", "remote"],
  });
  assert.equal("credentials" in (registry.get("ssh") ?? {}), false);
  assert.equal("target" in (registry.get("ssh") ?? {}), false);
});

test("provider identity and duplicate registration fail closed", () => {
  const registry = new ProviderRegistry();
  assert.throws(() => registry.register({ providerId: "", kind: "chatgpt", displayName: "ChatGPT", launchMode: "browser", capabilities: ["chat"] }), /identity/);
  registry.register({ providerId: "chatgpt-web", kind: "chatgpt", displayName: "ChatGPT", launchMode: "browser", capabilities: ["chat"] });
  assert.throws(() => registry.register({ providerId: "chatgpt-web", kind: "chatgpt", displayName: "ChatGPT", launchMode: "external", capabilities: ["chat"] }), /already registered/);
});
