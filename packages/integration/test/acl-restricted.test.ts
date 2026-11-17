import assert from "node:assert/strict";
import test from "node:test";
import { aclIsRestricted } from "../src/companion-service.js";

const file = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\nexus-svc-x\\nested\\companion.json";
const me = "runnervmm7ud1\\runneradmin";
const pad = " ".repeat(76);
const tail = "\n\nSuccessfully processed 1 files; Failed processing 0 files\r\n";
// Exact shape icacls printed on the GitHub Windows runner: long path form, three explicit ACEs.
const runner = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\nexus-svc-x\\nested\\companion.json NT AUTHORITY\\SYSTEM:(F)\n"
  + pad + "BUILTIN\\Administrators:(F)\n" + pad + me + ":(F)" + tail;
const withExtra = (principal: string): string => runner.replace(tail, "\n" + pad + principal + ":(R)" + tail);

test("aclIsRestricted accepts the account plus SYSTEM/Administrators (elevated default DACL)", () => {
  assert.equal(aclIsRestricted(runner, file, me), true);
});

test("aclIsRestricted rejects any other principal", () => {
  for (const principal of ["BUILTIN\\Users", "Everyone", "NT AUTHORITY\\Authenticated Users", "OTHERBOX\\someone"]) {
    assert.equal(aclIsRestricted(withExtra(principal), file, me), false, principal);
  }
});

test("aclIsRestricted requires the account itself and a recognisable listing", () => {
  assert.equal(aclIsRestricted("C:\\x\\companion.json NT AUTHORITY\\SYSTEM:(F)" + tail, "C:\\x\\companion.json", me), false);
  assert.equal(aclIsRestricted("garbage", file, me), false);
  assert.equal(aclIsRestricted(runner, "C:\\elsewhere\\other.json", me), false);
});
