import assert from "node:assert/strict";
import test from "node:test";
import { createSupervisorOutputSource, type OutputAttachable } from "../src/supervisor-output-source.js";

function fakeSupervisor(): { supervisor: OutputAttachable; modes: string[]; detaches: number[] } {
  const modes: string[] = [];
  const detaches: number[] = [];
  const supervisor: OutputAttachable = {
    attach(sessionId, mode) {
      modes.push(mode);
      if (sessionId === "gone") throw new Error("unknown session: gone");
      return { replay: sessionId === "boom" ? (null as unknown as string) : `out-${sessionId}`, detach: () => { detaches.push(1); } };
    },
  };
  return { supervisor, modes, detaches };
}

test("output source reads via a read attachment and always detaches", () => {
  const f = fakeSupervisor();
  const source = createSupervisorOutputSource(f.supervisor, "host-1");
  assert.equal(source.readOutput("host-1", "a", 1024), "out-a");
  assert.deepEqual(f.modes, ["read"]);
  assert.equal(f.detaches.length, 1);
});

test("output source returns null for another host or an unknown session, without attaching for the wrong host", () => {
  const f = fakeSupervisor();
  const source = createSupervisorOutputSource(f.supervisor, "host-1");
  assert.equal(source.readOutput("host-2", "a", 1024), null);
  assert.equal(f.modes.length, 0);
  assert.equal(source.readOutput("host-1", "gone", 1024), null);
  assert.equal(f.detaches.length, 0);
});

test("output source detaches even when reading the replay fails", () => {
  const detaches: number[] = [];
  const supervisor: OutputAttachable = {
    attach: () => ({ get replay(): string { throw new Error("boom"); }, detach: () => { detaches.push(1); } }),
  };
  assert.throws(() => createSupervisorOutputSource(supervisor, "host-1").readOutput("host-1", "a", 1024), /boom/);
  assert.equal(detaches.length, 1);
});
