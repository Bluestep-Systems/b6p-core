import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { IPersistence } from '../providers';
import { lockdownDir } from './dirLockdown';

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
 * Concurrency model: last-writer-wins. Reads always re-load from disk so a
 * change made by one process is visible to the other. Writes go to a temp
 * file and atomically rename into place to avoid partial-write corruption.
 *
 * Threat model: encryption protects against accidental disclosure (backups,
 * git commits, file shares). It does not protect against an attacker with
 * shell access as the same OS user, since the key sits next to the file.
 */
export class SharedFilePersistence implements IPersistence {
  private readonly configDir: string;
  private readonly statePath: string;
  private readonly secretsPath: string;
  private readonly keyPath: string;

  private cachedKey: Buffer | null = null;
  private dirReady = false;
  private pendingBootstrap: Promise<void> | null = null;

  constructor(configDirOverride?: string) {
    this.configDir = configDirOverride ?? path.join(os.homedir(), '.b6p');
    this.statePath = path.join(this.configDir, 'state.json');
    this.secretsPath = path.join(this.configDir, 'secrets.enc');
    this.keyPath = path.join(this.configDir, 'key');
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
    const state = await this.loadState();
    state[key] = value;
    await this.saveState(state);
  }

  async delete(key: string): Promise<void> {
    await this.waitBootstrap();
    const state = await this.loadState();
    delete state[key];
    await this.saveState(state);
  }

  async clearPublic(): Promise<void> {
    await this.waitBootstrap();
    await this.saveState({});
  }

  // ── Secret state ──────────────────────────────────────────────────

  async getSecret(key: string): Promise<string | undefined> {
    await this.waitBootstrap();
    const secrets = await this.loadSecrets();
    return secrets[key];
  }

  async setSecret(key: string, value: string): Promise<void> {
    await this.waitBootstrap();
    const secrets = await this.loadSecrets();
    secrets[key] = value;
    await this.saveSecrets(secrets);
  }

  async deleteSecret(key: string): Promise<void> {
    await this.waitBootstrap();
    const secrets = await this.loadSecrets();
    delete secrets[key];
    await this.saveSecrets(secrets);
  }

  async clearSecrets(): Promise<void> {
    await this.waitBootstrap();
    await this.saveSecrets({});
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
        await this.saveState(entries);
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

  private async loadState(): Promise<Record<string, unknown>> {
    return (await readJsonFile<Record<string, unknown>>(this.statePath)) ?? {};
  }

  private async saveState(state: Record<string, unknown>): Promise<void> {
    await this.ensureDir();
    await atomicWrite(this.statePath, JSON.stringify(state, null, 2));
  }

  // ── Internal: secrets ─────────────────────────────────────────────

  private async loadSecrets(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.secretsPath, 'utf-8');
    } catch {
      return {};
    }
    try {
      const blob = JSON.parse(raw) as { v: number; iv: string; tag: string; data: string };
      const key = await this.getOrCreateKey();
      const iv = Buffer.from(blob.iv, 'base64');
      const tag = Buffer.from(blob.tag, 'base64');
      const ciphertext = Buffer.from(blob.data, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf-8')) as Record<string, string>;
    } catch {
      // Corrupt or wrong key — start fresh rather than throwing.
      return {};
    }
  }

  private async saveSecrets(secrets: Record<string, string>): Promise<void> {
    await this.ensureDir();
    const key = await this.getOrCreateKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(secrets), 'utf-8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = {
      v: 1,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: ciphertext.toString('base64'),
    };
    await atomicWrite(this.secretsPath, JSON.stringify(blob));
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
      const hex = await fs.readFile(this.keyPath, 'utf-8');
      const buf = Buffer.from(hex.trim(), 'hex');
      if (buf.length === 32) {
        this.cachedKey = buf;
        return buf;
      }
      // Wrong-sized key file: regenerate.
    } catch {
      // No key yet.
    }
    const buf = crypto.randomBytes(32);
    await atomicWrite(this.keyPath, buf.toString('hex'));
    if (process.platform !== 'win32') {
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
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, contents, 'utf-8');
  await fs.rename(tmp, filePath);
}
