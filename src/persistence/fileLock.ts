import * as crypto from "crypto";
import * as fs from "fs/promises";

/**
 * How {@link withFileLock} waits.
 * @lastreviewed null
 */
export interface FileLockOptions {
  /**
   * How long to wait for the lock before giving up (default 10 s). Every failed attempt counts
   * against it, whatever the error: a lock held by another process, a file system that refuses the
   * lockfile (`EPERM`, `EACCES`, as a Windows sharing restriction does), or a takeover that failed.
   * @lastreviewed null
   */
  readonly timeoutMs?: number;
  /**
   * A lockfile older than this is taken to be left by a process that died holding it, and is
   * taken over (default 30 s). The work done under the lock must be much shorter.
   * @lastreviewed null
   */
  readonly staleMs?: number;
  /**
   * How long to sleep between attempts (default 20 ms).
   * @lastreviewed null
   */
  readonly retryMs?: number;
}

/**
 * The defaults of {@link FileLockOptions}.
 * @lastreviewed null
 */
export const FILE_LOCK_DEFAULTS = { timeoutMs: 10_000, staleMs: 30_000, retryMs: 20 } as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

/**
 * Move the lockfile aside, but only if it is still the one whose content was `expected`: renamed
 * to a name of this waiter's own (atomic, so of two waiters only one gets any given file), then
 * read there. When it held `expected` it is deleted and `true` returned. When it held something
 * else, another process took the lock after `expected` was read, so the file is put back (by
 * hard link, which never replaces a lock taken in the meantime) and `false` returned.
 * @lastreviewed null
 */
async function removeIfStill(lockPath: string, expected: string, aside: string): Promise<boolean> {
  await fs.rename(lockPath, aside);
  let moved: string | undefined;
  try {
    moved = await fs.readFile(aside, "utf8");
  } catch {
    moved = undefined;
  }
  if (moved === expected) {
    await fs.unlink(aside);
    return true;
  }
  try {
    await fs.link(aside, lockPath);
  } finally {
    await fs.unlink(aside).catch(() => undefined);
  }
  return false;
}

/**
 * Run `work` while holding the lockfile `lockPath`, created exclusively (`wx`) with a stamp unique
 * to this call (pid, time, random token) and removed after.
 *
 * A lockfile older than `staleMs` is taken over without ever removing a lock another process has
 * just taken: its content is read, the file is renamed to a name unique to this waiter, and only
 * if the renamed file still holds that content is it deleted; otherwise it is put back. Release
 * works the same way, removing only a file that holds this call's stamp. Every failed attempt,
 * whatever its error, sleeps `retryMs` and counts against `timeoutMs`.
 *
 * @throws {Error} when the lock is not acquired within `timeoutMs`.
 * @lastreviewed null
 */
export async function withFileLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? FILE_LOCK_DEFAULTS.timeoutMs;
  const staleMs = options.staleMs ?? FILE_LOCK_DEFAULTS.staleMs;
  const retryMs = options.retryMs ?? FILE_LOCK_DEFAULTS.retryMs;
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomBytes(12).toString("hex");
  const stamp = `${process.pid} ${Date.now()} ${token}`;
  let asides = 0;
  const aside = (): string => `${lockPath}.${token}.${++asides}.aside`;
  let lastCode: string | undefined;
  for (;;) {
    let tookOver = false;
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(stamp);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      lastCode = errorCode(error);
    }
    if (lastCode === "EEXIST") {
      try {
        const [stat, held] = await Promise.all([fs.stat(lockPath), fs.readFile(lockPath, "utf8")]);
        if (Date.now() - stat.mtimeMs > staleMs) {
          tookOver = await removeIfStill(lockPath, held, aside());
        }
      } catch (error) {
        // Released, replaced or refused between the steps: the next attempt sees what is there now.
        lastCode = errorCode(error) ?? lastCode;
      }
    }
    if (Date.now() >= deadline) {
      const why = lastCode === undefined || lastCode === "EEXIST" ? "" : ` (${lastCode})`;
      throw new Error(`Timed out waiting for a lock on b6p's shared state${why}.`);
    }
    if (!tookOver) {
      await sleep(retryMs);
    }
  }
  try {
    return await work();
  } finally {
    try {
      if ((await fs.readFile(lockPath, "utf8")) === stamp) {
        await removeIfStill(lockPath, stamp, aside());
      }
    } catch {
      // Already gone (taken over as stale) or refused: nothing of this call's to release.
    }
  }
}
