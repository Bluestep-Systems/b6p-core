import * as fs from "fs";

/**
 * Files this process created and must not leave behind if it stops: b6p's own lockfiles while held
 * (and any whose release was refused), and git's `<config>.lock` while b6p edits a config file. As
 * git's tempfile.c does, each is removed on exit, on SIGINT, SIGTERM and SIGHUP when no handler of
 * the host's will deal with the signal, and on an uncaught exception that ends the process, but only
 * while `stillMine` (a synchronous check: the device and inode b6p created, and for b6p's own lock
 * its stamp too) says the file is the one this process made.
 * @lastreviewed null
 */
export interface ExitCleanupEntry {
  readonly path: string;
  readonly stillMine: () => boolean;
}

const entries = new Set<ExitCleanupEntry>();
let installed = false;
// Signals a handler of the host's was removed from in the current turn of the event loop: a `once` handler (or one
// that removes itself) taking this very signal, before b6p's own handler runs. Cleared on the next turn.
const hostJustRemoved = new Set<string | symbol>();

/**
 * A `stillMine` check for a file this process created: the same device and inode (as bigints, so no
 * precision is lost) as `made`, and, when `content` is given, exactly that content, so a reused
 * inode under another process's lock is never taken for this one.
 * @lastreviewed null
 */
export function sameFile(path: string, made: fs.BigIntStats, content?: string): () => boolean {
  return () => {
    try {
      const now = fs.statSync(path, { bigint: true });
      if (now.dev !== made.dev || now.ino !== made.ino) {
        return false;
      }
      return content === undefined || fs.readFileSync(path, "utf8") === content;
    } catch {
      return false;
    }
  };
}

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

// b6p's handler alone: clean up and stop as the signal's default would, so the exit status stays what it would have
// been. With a handler of the host's listening, do nothing: if it exits, the `exit` listener cleans up; if it keeps
// the process alive, the work in flight keeps its locks. When the host's `once` handler took this same signal, stand
// aside for this one: it is running its shutdown. A later signal, with b6p's handler alone again, stops the process.
function onSignal(signal: NodeJS.Signals): void {
  if (process.listenerCount(signal) !== 1 || hostJustRemoved.has(signal)) {
    return;
  }
  runExitCleanup();
  process.removeListener(signal, onSignal);
  process.kill(process.pid, signal);
}

function install(): void {
  if (installed) {
    return;
  }
  installed = true;
  process.on("removeListener", (event, listener) => {
    if (listener !== onSignal && (SIGNALS as readonly (string | symbol)[]).includes(event)) {
      hostJustRemoved.add(event);
      setImmediate(() => hostJustRemoved.delete(event)).unref();
    }
  });
  process.on("exit", runExitCleanup);
  process.on("uncaughtExceptionMonitor", () => {
    // With a handler of its own (an extension host) or a capture callback, the process lives on and the work may
    // still hold its locks.
    if (process.listenerCount("uncaughtException") === 0 && !process.hasUncaughtExceptionCaptureCallback()) {
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
