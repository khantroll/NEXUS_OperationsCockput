import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const main = path.resolve(here, "../dist/main/main.js");

function run(mode, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [main, "--no-sandbox", "--disable-gpu"], {
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        ...(mode === "seed"
          ? { NEXUS_DESKTOP_RECOVERY_SEED: "1" }
          : { NEXUS_DESKTOP_RECOVERY_RELAUNCH: "1" }),
      },
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${mode} recovery smoke timed out`));
    }, 30000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0 && output.includes(marker)) resolve(output);
      else reject(new Error(`${mode} recovery smoke failed with code ${code}`));
    });
  });
}

try {
  await run("seed", "NEXUS recovery seed passed");
  await run("relaunch", "NEXUS recovery relaunch passed");
  console.log("NEXUS restart recovery smoke passed");
} catch (error) {
  console.error(error);
  process.exit(1);
}
