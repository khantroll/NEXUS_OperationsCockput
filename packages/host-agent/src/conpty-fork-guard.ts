import { createRequire } from "node:module";
import type { ForkOptions } from "node:child_process";

const CONPTY_AGENT_SCRIPT = "conpty_console_list_agent";

type ForkFn = typeof import("node:child_process").fork;
type ForkModulePath = Parameters<ForkFn>[0];

let installed = false;

/**
 * node-pty's Windows kill path forks `conpty_console_list_agent` without
 * custom execArgv, so the helper inherits the parent's flags. Under
 * `node --test` that makes the helper a nested test runner. When the PTY
 * has already exited the helper throws `AttachConsole failed` at top level
 * and the parent test file is marked failed at line 1.
 *
 * The guard also hides the helper's stderr (the diagnostic is expected after
 * a clean wait-for-exit) and clears test-runner env so the helper cannot
 * join the parent run. Dispose still calls `pty.kill()` to release the
 * native ConPTY handle.
 */
export function installConptyForkGuard(): void {
  if (installed) return;
  const childProcess = createRequire(import.meta.url)("child_process") as { fork: ForkFn };
  const originalFork: ForkFn = childProcess.fork.bind(childProcess);
  const guarded = ((modulePath: ForkModulePath, argsOrOptions?: readonly string[] | ForkOptions, maybeOptions?: ForkOptions) => {
    const script = modulePathToString(modulePath);
    const parsed = parseForkCall(argsOrOptions, maybeOptions);
    if (!script.includes(CONPTY_AGENT_SCRIPT)) {
      return invokeFork(originalFork, modulePath, parsed.args, parsed.options);
    }
    const guardedOptions: ForkOptions = {
      ...parsed.options,
      execArgv: sanitizeExecArgv(parsed.options.execArgv ?? process.execArgv),
      env: envWithoutTestContext(parsed.options.env ?? process.env),
      silent: parsed.options.silent ?? true,
    };
    return invokeFork(originalFork, modulePath, parsed.args, guardedOptions);
  }) as ForkFn;
  childProcess.fork = guarded;
  installed = true;
}

export function sanitizeExecArgv(execArgv: readonly string[]): string[] {
  return execArgv.filter((arg) => {
    const name = arg.split("=")[0] ?? arg;
    return name !== "--test"
      && !name.startsWith("--test-")
      && name !== "--watch"
      && name !== "--watch-path"
      && name !== "--experimental-test-isolation"
      && name !== "--experimental-test-module-mocks"
      && name !== "--experimental-test-coverage";
  });
}

export function envWithoutTestContext(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.NODE_TEST_CONTEXT;
  return next;
}

function parseForkCall(
  argsOrOptions?: readonly string[] | ForkOptions,
  maybeOptions?: ForkOptions,
): { args?: readonly string[]; options: ForkOptions } {
  if (argsOrOptions === undefined) return { options: maybeOptions ?? {} };
  if (isForkArgList(argsOrOptions)) return { args: argsOrOptions, options: maybeOptions ?? {} };
  return { options: argsOrOptions };
}

function isForkArgList(value: readonly string[] | ForkOptions): value is readonly string[] {
  return Array.isArray(value);
}

function invokeFork(
  fork: ForkFn,
  modulePath: ForkModulePath,
  args: readonly string[] | undefined,
  options: ForkOptions,
): ReturnType<ForkFn> {
  return args === undefined ? fork(modulePath, options) : fork(modulePath, args, options);
}

function modulePathToString(modulePath: ForkModulePath): string {
  if (typeof modulePath === "string") return modulePath;
  if (modulePath instanceof URL) return modulePath.pathname;
  return String(modulePath);
}
