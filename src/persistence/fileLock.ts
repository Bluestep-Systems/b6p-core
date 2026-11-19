import * as fs from "fs/promises";

/**
 * How {@link withFileLock} waits.
 * @lastreviewed null
 */
export interface FileLockOptions {
  /**
   * How long to wait for the lock before giving up (default 10 s).
   * @lastreviewed null
   */
  readonly timeoutMs?: number;
  /**
   * A lockfile older than this is taken to be left by a process that died holding it, and is
   * removed (default 30 s). The work done under the lock must be much shorter.
   * @lastreviewed null
   */
  readonly staleMs?: number;
  /**
   * How long to sleep between attempts (default 20 ms).
   * @lastreviewed null
   */
  readonly retryMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `work` while holding the lockfile `lockPath`, created exclusively (`wx`) and removed after.
 * A lockfile older than `staleMs` is removed, but only if it still holds what was read from it, so
 * a waiter does not remove a lock another waiter has just taken. That check and the removal are
 * not atomic: two waiters that both find the same stale lock can still race, which is acceptable
 * for the short state updates this guards.
 *
 * @throws {Error} when the lock is not acquired within `timeoutMs`.
 * @lastreviewed null
 */
export async function withFileLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const retryMs = options.retryMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  const stamp = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)}`;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(stamp);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    try {
      const [stat, holder] = await Promise.all([fs.stat(lockPath), fs.readFile(lockPath, "utf8")]);
      if (Date.now() - stat.mtimeMs > staleMs && (await fs.readFile(lockPath, "utf8")) === holder) {
        await fs.unlink(lockPath);
        continue;
      }
    } catch {
      // Released (or replaced) between the attempts: try again at once.
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for a lock on b6p's shared state.");
    }
    await sleep(retryMs);
  }
  try {
    return await work();
  } finally {
    try {
      if ((await fs.readFile(lockPath, "utf8")) === stamp) {
        await fs.unlink(lockPath);
      }
    } catch {
      // Already gone (removed as stale): nothing to release.
    }
  }
}
