import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import type { Persistence, LockDiagnoser, LockHolder } from "../providers";
import { lockdownDir } from "./dirLockdown";
import { withFileLock } from "./fileLock";

/**
 * Cross-platform shared persistence backed by files in `~/.b6p`.
 *
 * Designed so the CLI and the VS Code extension can read/write the same
 * workspace state and credentials. Both sides instantiate this provider with
 * the same workspace root path; the workspace hash determines the public
 * state file, and secrets are shared globally per OS user.
 *
 * Layout:
 *   ~/.b6p/                     (chmod 700 / Windows ACL: user-only)
 *     key                       AES-256 key, 32 random bytes hex-encoded
 *     state.json                shared public state (plaintext JSON)
 *     secrets.enc               AES-256-GCM encrypted JSON of all secrets
 *
 * State is intentionally NOT keyed by workspace path: the CLI and VS Code
 * extension frequently disagree on what that path is (symlinks, workspace
 * opened above the U-folder, etc.), and `ScriptMetaDataStore` already keys
 * its contents by org+script internally, so a single global file is enough.
 *
 * Concurrency model. Reads always re-load from disk so a change made by one
 * process is visible to the other. Writes go to a temp file and atomically
 * rename into place to avoid partial-write corruption.
 * Every write of the state file (`set`, `delete`, `clearPublic`, a seed) holds
 * one lock for the whole file, `state.json.lock`, shared by every process: it
 * re-loads the file under that lock and changes only its own key, so no write
 * of any key (a setting, a cache entry, a record) is ever lost to another
 * process's. Within one process those writes also queue, as do the secrets
 * file's (`setSecret`/`deleteSecret`/`clearSecrets`, which take no
 * cross-process lock and stay last-writer-wins across processes).
 * A caller whose new value depends on the old one (a read-modify-write of one
 * key) still wraps the read and the write in {@link withLock}.
 *
 * Threat model: encryption protects against accidental disclosure (backups,
 * git commits, file shares). It does not protect against an attacker with
 * shell access as the same OS user, since the key sits next to the file.
 */
export class SharedFilePersistence implements Persistence {
  private readonly configDir: string;
  private readonly statePath: string;
  private readonly secretsPath: string;
  private readonly keyPath: string;

  private cachedKey: Buffer | null = null;
  private dirReady = false;
  private pendingBootstrap: Promise<void> | null = null;
  private readonly lockDiagnoser?: LockDiagnoser;

  constructor(configDirOverride?: string, lockDiagnoser?: LockDiagnoser) {
    this.configDir = configDirOverride ?? path.join(os.homedir(), ".b6p");
    this.statePath = path.join(this.configDir, "state.json");
    this.secretsPath = path.join(this.configDir, "secrets.enc");
    this.keyPath = path.join(this.configDir, "key");
    this.lockDiagnoser = lockDiagnoser;
  }

  /**
   * Schedule a one-time bootstrap step (typically a legacy-store migration)
   * that must complete before any read/write returns. Subsequent calls
   * overwrite the pending step. Errors are swallowed so a failed migration
   * never blocks the persistence layer entirely.
   */
  setPendingBootstrap(bootstrap: () => Promise<void>): void {
    this.pendingBootstrap = bootstrap().catch(() => undefined);
  }

  private async waitBootstrap(): Promise<void> {
    if (this.pendingBootstrap) {
      await this.pendingBootstrap;
    }
  }

  // ── Public state ──────────────────────────────────────────────────

  async get<T>(key: string): Promise<T | undefined> {
    await this.waitBootstrap();
    const state = await this.loadState();
    return state[key] as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.waitBootstrap();
    await this.mutateState((state) => {
      state[key] = value;
      return state;
    });
  }

  async delete(key: string): Promise<void> {
    await this.waitBootstrap();
    await this.mutateState((state) => {
      delete state[key];
      return state;
    });
  }

  async clearPublic(): Promise<void> {
    await this.waitBootstrap();
    await this.mutateState(() => ({}));
  }

  /**
   * Clear the public state file but `keep`'s keys, in one locked write.
   * @lastreviewed null
   */
  async clearPublicExcept(keep: readonly string[]): Promise<void> {
    await this.waitBootstrap();
    await this.mutateState((state) => {
      const kept: Record<string, unknown> = {};
      for (const key of keep) {
        if (key in state) {
          kept[key] = state[key];
        }
      }
      return kept;
    });
  }

  // ── Secret state ──────────────────────────────────────────────────

  async getSecret(key: string): Promise<string | undefined> {
    await this.waitBootstrap();
    const secrets = await this.loadSecrets();
    return secrets[key];
  }

  async setSecret(key: string, value: string): Promise<void> {
    await this.waitBootstrap();
    await this.mutateSecrets((secrets) => {
      secrets[key] = value;
      return secrets;
    });
  }

  async deleteSecret(key: string): Promise<void> {
    await this.waitBootstrap();
    await this.mutateSecrets((secrets) => {
      delete secrets[key];
      return secrets;
    });
  }

  async clearSecrets(): Promise<void> {
    await this.waitBootstrap();
    await this.mutateSecrets(() => ({}));
  }

  // ── Migration helper ──────────────────────────────────────────────

  /**
   * Seed the shared store from a legacy source if (and only if) the relevant
   * file does not yet exist on disk. Used to migrate from VS Code's
   * `workspaceState` / `SecretStorage` and from the old `DotfilePersistence`
   * layout. Safe to call repeatedly: it short-circuits once a file is present.
   */
  async seedIfMissing(seed: {
    publicEntries?: () => Promise<Record<string, unknown>>;
    secretEntries?: () => Promise<Record<string, string>>;
  }): Promise<void> {
    if (seed.publicEntries && !(await fileExists(this.statePath))) {
      const entries = await seed.publicEntries();
      if (entries && Object.keys(entries).length > 0) {
        // Under the state lock, and only while the file is still missing, so a write another process made since the
        // check above is not replaced.
        await this.mutateState((state) => (Object.keys(state).length === 0 ? entries : state));
      }
    }
    if (seed.secretEntries && !(await fileExists(this.secretsPath))) {
      const entries = await seed.secretEntries();
      if (entries && Object.keys(entries).length > 0) {
        await this.saveSecrets(entries);
      }
    }
  }

  // ── Internal: state ───────────────────────────────────────────────

  /**
   * Run one load → change → save of the public state file as a single turn of that file's
   * in-process queue, holding the state file's cross-process lock (`state.json.lock`) from the
   * load to the save, so a write by another process is never overwritten with what this one
   * loaded before it.
   * @lastreviewed null
   */
  private mutateState(change: (state: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
    return enqueueFileMutation(this.statePath, async () => {
      await this.ensureDir();
      await withFileLock(`${this.statePath}.lock`, async () => {
        await this.saveState(change(await this.loadState()));
      });
    });
  }

  private async loadState(): Promise<Record<string, unknown>> {
    return (await readJsonFile<Record<string, unknown>>(this.statePath)) ?? {};
  }

  private async saveState(state: Record<string, unknown>): Promise<void> {
    await this.ensureDir();
    await atomicWrite(this.statePath, JSON.stringify(state, null, 2), this.lockDiagnoser);
  }

  // ── Internal: secrets ─────────────────────────────────────────────

  /**
   * Run one load → change → save of the secrets file as a single turn of that file's in-process
   * queue, re-loading inside the turn so it starts from the latest file. Without this, two
   * overlapping mutations each loaded the same blob and the later save dropped the earlier
   * change: `SessionManager` re-saving `sessions` could write a just-rotated `bearerAuth` back to
   * the old token. A failed turn does not stall the queue. In-process only; no cross-process lock.
   * @lastreviewed null
   */
  private mutateSecrets(change: (secrets: Record<string, string>) => Record<string, string>): Promise<void> {
    return enqueueFileMutation(this.secretsPath, async () => {
      await this.saveSecrets(change(await this.loadSecrets()));
    });
  }

  private async loadSecrets(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.secretsPath, "utf-8");
    } catch {
      return {};
    }
    try {
      const blob = JSON.parse(raw) as { v: number; iv: string; tag: string; data: string };
      const key = await this.getOrCreateKey();
      const iv = Buffer.from(blob.iv, "base64");
      const tag = Buffer.from(blob.tag, "base64");
      const ciphertext = Buffer.from(blob.data, "base64");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString("utf-8")) as Record<string, string>;
    } catch {
      // Corrupt or wrong key — start fresh rather than throwing.
      return {};
    }
  }

  private async saveSecrets(secrets: Record<string, string>): Promise<void> {
    await this.ensureDir();
    const key = await this.getOrCreateKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const plaintext = Buffer.from(JSON.stringify(secrets), "utf-8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = {
      v: 1,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: ciphertext.toString("base64"),
    };
    await atomicWrite(this.secretsPath, JSON.stringify(blob), this.lockDiagnoser);
  }

  /**
   * Run `work` holding `<configDir>/<name>.lock`, created exclusively and removed after, so the CLI
   * and the extension (and two CLI processes) take turns. Within this process the same lock is
   * also queued, so two instances over the same directory do not poll each other. The lock keeps a
   * heartbeat for as long as `work` runs ({@link withFileLock}); one left by a process that died is
   * taken over once its heartbeat is 5 s old, or at once when its process is gone; waiting gives up
   * after 10 s.
   * @lastreviewed null
   */
  async withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
    await this.waitBootstrap();
    await this.ensureDir();
    const lockPath = path.join(this.configDir, `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`);
    const tail = LOCK_QUEUES.get(lockPath) ?? Promise.resolve();
    const run = tail.then(
      () => withFileLock(lockPath, work),
      () => withFileLock(lockPath, work)
    );
    LOCK_QUEUES.set(
      lockPath,
      run.catch(() => undefined)
    );
    return run;
  }

  // ── Internal: dir + key bootstrap ─────────────────────────────────

  private async ensureDir(): Promise<void> {
    if (this.dirReady) {
      return;
    }
    await fs.mkdir(this.configDir, { recursive: true });
    await lockdownDir(this.configDir);
    this.dirReady = true;
  }

  private async getOrCreateKey(): Promise<Buffer> {
    if (this.cachedKey) {
      return this.cachedKey;
    }
    await this.ensureDir();
    try {
      const hex = await fs.readFile(this.keyPath, "utf-8");
      const buf = Buffer.from(hex.trim(), "hex");
      if (buf.length === 32) {
        this.cachedKey = buf;
        return buf;
      }
      // Wrong-sized key file: regenerate.
    } catch {
      // No key yet.
    }
    const buf = crypto.randomBytes(32);
    await atomicWrite(this.keyPath, buf.toString("hex"), this.lockDiagnoser);
    if (process.platform !== "win32") {
      try {
        await fs.chmod(this.keyPath, 0o600);
      } catch {
        // Best-effort.
      }
    }
    this.cachedKey = buf;
    return buf;
  }
}

/**
 * The tail of each file's in-process mutation queue (`secrets.enc`, `state.json`), keyed by path,
 * so two {@link SharedFilePersistence} instances over the same directory share one queue.
 * @lastreviewed null
 */
const FILE_MUTATIONS = new Map<string, Promise<void>>();

/**
 * The tail of each lockfile's in-process queue ({@link SharedFilePersistence.withLock}), keyed by path.
 * @lastreviewed null
 */
const LOCK_QUEUES = new Map<string, Promise<unknown>>();

/**
 * Run `mutation` after every mutation already queued for `filePath`. A failed one does not stall
 * the queue.
 * @lastreviewed null
 */
function enqueueFileMutation(filePath: string, mutation: () => Promise<void>): Promise<void> {
  const tail = FILE_MUTATIONS.get(filePath) ?? Promise.resolve();
  const result = tail.then(mutation, mutation);
  FILE_MUTATIONS.set(
    filePath,
    result.catch(() => undefined)
  );
  return result;
}

// ── File helpers ────────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// Windows rejects a rename over a target momentarily held open by another
// process (real-time AV / ransomware protection, file sync, an editor, or a
// second b6p process) with EPERM/EBUSY/EACCES. The hold is transient, so we
// retry with backoff before giving up. Spacing the renames out also dampens
// the rapid write-then-rename burst that trips ransomware heuristics in the
// first place. A kernel filesystem minifilter (e.g. Sophos CryptoGuard) holds
// no user-mode handle, so an LockDiagnoser can only confirm "no user-mode
// locker" — which is itself a minifilter fingerprint (see buildRenameError).
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1000] as const;
const RENAME_MAX_ATTEMPTS = RENAME_RETRY_DELAYS_MS.length + 1;

async function atomicWrite(filePath: string, contents: string, lockDiagnoser?: LockDiagnoser): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fs.writeFile(tmp, contents, "utf-8");
  } catch (err) {
    // A failed temp write may still leave a partial file behind.
    await safeUnlink(tmp);
    throw err;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (err) {
      const code = errnoCode(err);
      if (!code || !RENAME_RETRY_CODES.has(code)) {
        // Not a transient-lock error — clean up and surface immediately.
        await safeUnlink(tmp);
        throw err;
      }
      lastError = err;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        await sleep(delay);
      }
    }
  }

  // All retries exhausted: remove the orphaned temp file so we don't leave
  // residue, then throw an annotated error. The diagnoser is best-effort and
  // must never mask `lastError`.
  await safeUnlink(tmp);
  throw await buildRenameError(filePath, lastError, lockDiagnoser);
}

function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const { code } = err as { code?: unknown };
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    // Best-effort cleanup — a leftover temp file is harmless.
  }
}

// How long we wait for a best-effort lock diagnosis before giving up on it.
// A hung diagnoser (e.g. Windows Restart Manager wedging) must not turn an
// already-failed write into an indefinite hang.
const DIAGNOSE_TIMEOUT_MS = 2_000;

async function buildRenameError(
  filePath: string,
  originalError: unknown,
  lockDiagnoser?: LockDiagnoser
): Promise<Error> {
  const fileName = path.basename(filePath);
  const dir = path.dirname(filePath);
  const code = errnoCode(originalError) ?? "unknown error";
  const prefix = `Could not write ${fileName} after ${RENAME_MAX_ATTEMPTS} attempts (${code})`;

  // `null` means no diagnoser, or the diagnosis failed/timed out — in which
  // case we must NOT claim the "minifilter" fingerprint. A non-null array
  // means the diagnosis actually completed (empty array = no user-mode holder).
  const holders = lockDiagnoser ? await diagnoseSafely(lockDiagnoser, filePath) : null;

  if (holders && holders.length > 0) {
    const list = holders.map((h) => `${h.name} (${h.pid})`).join(", ");
    return annotateError(originalError, `${prefix} — locked by ${list}.`);
  }

  const hint =
    holders !== null
      ? // Diagnosis completed but found no user-mode holder — that empty result
        // is itself the fingerprint of a kernel filesystem minifilter.
        `No user-mode process holds the file — this signature points to a filesystem minifilter ` +
        `(real-time AV / ransomware protection such as Sophos CryptoGuard) intercepting the rename. ` +
        `Consider a scanning exclusion for ${dir}.`
      : // No diagnoser, or the diagnosis failed/timed out — stay non-committal.
        `The destination may be held open by another process (real-time AV, file sync, an editor, or a ` +
        `second b6p process). Consider a scanning exclusion for ${dir}.`;
  return annotateError(originalError, `${prefix}. ${hint}`);
}

/**
 * Produces the error to throw for an exhausted rename. When the underlying
 * failure is a real `Error`, we reuse it and only replace its message, so the
 * errno metadata (`.code`, `.path`, `.syscall`) and original stack survive for
 * callers that branch on them. Non-`Error` throwables are wrapped with `cause`.
 * @lastreviewed null
 */
function annotateError(originalError: unknown, message: string): Error {
  if (originalError instanceof Error) {
    originalError.message = message;
    return originalError;
  }
  return new Error(message, { cause: originalError });
}

/**
 * Runs the best-effort diagnoser, guarded by a timeout. Returns the holders on
 * success, or `null` if the diagnoser threw or did not answer in time — so the
 * caller can distinguish "diagnosed, none found" from "could not diagnose".
 * @lastreviewed null
 */
async function diagnoseSafely(lockDiagnoser: LockDiagnoser, filePath: string): Promise<LockHolder[] | null> {
  try {
    return await Promise.race([
      lockDiagnoser.diagnose(filePath),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DIAGNOSE_TIMEOUT_MS)),
    ]);
  } catch {
    // Diagnoser is best-effort — never let it mask the original error.
    return null;
  }
}
