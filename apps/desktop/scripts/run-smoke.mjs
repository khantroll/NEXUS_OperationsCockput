import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const main = path.resolve(here, "../dist/main/main.js");

const child = spawn(electron, [main, "--no-sandbox", "--disable-gpu"], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, NEXUS_DESKTOP_SMOKE: "1" },
});

let output = "";
let finished = false;
const timeout = setTimeout(() => finish(output.includes("NEXUS reload smoke passed") ? 0 : 1), 30000);

function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (child.exitCode === null) child.kill();
  process.exit(code);
}

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
  if (output.includes("NEXUS reload smoke passed")) setTimeout(() => finish(0), 500);
});

child.on("error", () => finish(1));
child.on("exit", (code, signal) => {
  if (signal) finish(1);
  else finish(code ?? (output.includes("NEXUS reload smoke passed") ? 0 : 1));
});
