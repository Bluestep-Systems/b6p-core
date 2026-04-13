import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Restrict a directory so only the current OS user can read/write/list it.
 *
 * - POSIX: `chmod 700`.
 * - Windows: `icacls` with inheritance disabled and a single grant to the
 *   current user. `icacls` ships with Windows Vista and later, no install
 *   required. Failure to lock down is logged but not fatal — the directory
 *   still functions, just without the access restriction.
 *
 * The directory must already exist.
 */
export async function lockdownDir(dir: string): Promise<void> {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME || process.env.USER;
    if (!user) {
      return;
    }
    try {
      await execFileAsync('icacls', [
        dir,
        '/inheritance:r',
        '/grant:r',
        `${user}:(OI)(CI)F`,
      ]);
    } catch {
      // Best-effort: if icacls is missing or fails, leave the directory alone.
    }
    return;
  }

  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // Best-effort.
  }
}
