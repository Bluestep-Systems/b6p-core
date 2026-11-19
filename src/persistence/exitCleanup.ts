import * as fs from "fs";

/**
 * Files this process created and must not leave behind if it stops: b6p's own lockfiles while held
 * (and any whose release was refused), and git's `<config>.lock` while b6p edits a config file. As
 * git's tempfile.c does, each is removed on exit, on SIGINT, SIGTERM and SIGHUP, and on an uncaught
 * exception that ends the process, but only while `stillMine` (a synchronous check: the stamp or the
 * inode b6p created) says the file is the one this process made.
 * @lastreviewed null
 */
export interface ExitCleanupEntry {
  readonly path: string;
  readonly stillMine: () => boolean;
}

const entries = new Set<ExitCleanupEntry>();
let installed = false;

/**
 * Remove every registered file that is still this process's, synchronously; never throws.
 * @lastreviewed null
 */
export function runExitCleanup(): void {
  for (const entry of [...entries]) {
    try {
      if (entry.stillMine()) {
        fs.unlinkSync(entry.path);
      }
    } catch {
      // Gone already, or refused: nothing more can be done while the process stops.
    }
    entries.delete(entry);
  }
}

const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function onSignal(signal: NodeJS.Signals): void {
  runExitCleanup();
  // Only listener: stop as the signal's default would, so the exit status stays what it would have been.
  if (process.listenerCount(signal) === 1) {
    process.removeListener(signal, onSignal);
    process.kill(process.pid, signal);
  }
}

function install(): void {
  if (installed) {
    return;
  }
  installed = true;
  process.on("exit", runExitCleanup);
  process.on("uncaughtExceptionMonitor", () => {
    // With a handler of its own (an extension host), the process lives on and the work may still hold its locks.
    if (process.listenerCount("uncaughtException") === 0) {
      runExitCleanup();
    }
  });
  for (const signal of SIGNALS) {
    try {
      process.on(signal, onSignal);
    } catch {
      // A platform without this signal.
    }
  }
}

/**
 * Register `path` for removal if the process stops; returns the entry, for {@link untrackOnExit}.
 * Installs the exit and signal handlers once per process.
 * @lastreviewed null
 */
export function trackOnExit(path: string, stillMine: () => boolean): ExitCleanupEntry {
  install();
  const entry = { path, stillMine };
  entries.add(entry);
  return entry;
}

/**
 * Stop tracking `entry` (the file was removed or handed on).
 * @lastreviewed null
 */
export function untrackOnExit(entry: ExitCleanupEntry): void {
  entries.delete(entry);
}
