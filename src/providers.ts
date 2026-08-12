import type { B6PUri } from "./B6PUri";
import type { OrgCacheSettings } from "./cache/OrgCache";
import type { AuthParams } from "./types";

// ── File System ─────────────────────────────────────────────────────

export interface FileStat {
  type: "file" | "directory";
  mtime: number;
  size: number;
}

export interface FileSystem {
  readFile(uri: B6PUri): Promise<Uint8Array>;
  writeFile(uri: B6PUri, content: Uint8Array): Promise<void>;
  stat(uri: B6PUri): Promise<FileStat>;
  readDirectory(uri: B6PUri): Promise<[string, "file" | "directory"][]>;
  delete(uri: B6PUri, options?: { recursive?: boolean }): Promise<void>;
  createDirectory(uri: B6PUri): Promise<void>;
  exists(uri: B6PUri): Promise<boolean>;
  copy(source: B6PUri, target: B6PUri, options?: { overwrite?: boolean }): Promise<void>;
  rename(source: B6PUri, target: B6PUri, options?: { overwrite?: boolean }): Promise<void>;
  findFiles(base: B6PUri, include: string, exclude?: string): Promise<B6PUri[]>;

  /**
   * Walk up from `startUri` looking for a sibling file named `fileName`.
   * Returns the URI of the first match, or `null` if none found within `maxDepth` levels.
   */
  closest(startUri: B6PUri, fileName: string, maxDepth?: number): Promise<B6PUri | null>;

  /**
   * Check whether a URI scheme supports write operations.
   * Returns `true` if writable, `false` if read-only, `undefined` if unknown.
   */
  isWritableFileSystem(scheme: string): boolean | undefined;
}

// ── Persistence ─────────────────────────────────────────────────────

export interface Persistence {
  /** Read a value from public (workspace-scoped) state. */
  get<T>(key: string): Promise<T | undefined>;
  /** Write a value to public (workspace-scoped) state. */
  set<T>(key: string, value: T): Promise<void>;
  /** Delete a value from public state. */
  delete(key: string): Promise<void>;

  /** Read a value from secret (credential) storage. */
  getSecret(key: string): Promise<string | undefined>;
  /** Write a value to secret storage. */
  setSecret(key: string, value: string): Promise<void>;
  /** Delete a value from secret storage. */
  deleteSecret(key: string): Promise<void>;

  /** Clear all public state. */
  clearPublic(): Promise<void>;
  /** Clear all secret state. */
  clearSecrets(): Promise<void>;
}

// ── User Interaction ────────────────────────────────────────────────

export interface Prompt {
  /** Show an input box and return the entered string, or undefined if cancelled. */
  inputBox(options: { prompt: string; password?: boolean; value?: string }): Promise<string | undefined>;

  /**
   * Prompt the user with a message and a set of options.
   * Returns the exact string of the selected option, or undefined if dismissed.
   */
  confirm(message: string, options: string[]): Promise<string | undefined>;

  /** Informational message (non-blocking). */
  info(message: string): void;
  /** Modal informational message (blocking until dismissed). */
  popup(message: string): Promise<void>;
  /** Warning message (non-blocking). */
  warn(message: string): void;
  /** Error message (non-blocking). */
  error(message: string): void;
}

// ── Authentication ─────────────────────────────────────────────────

/**
 * An authentication scheme: owns a credential's whole lifecycle and renders the
 * `Authorization` header from it. `T` is the scheme's credential shape, so a
 * consumer can substitute a different scheme without core knowing what it holds.
 *
 * `T` occurs only in return position, which makes the interface covariant in it:
 * an `AuthProvider<BearerAuthParams>` is assignable to `AuthProvider<AuthParams>`,
 * so core can hold the general type while a concrete scheme supplies the specific
 * one.
 */
export interface AuthProvider<T extends AuthParams> {
  /** Returns the value for the HTTP Authorization header. */
  authHeaderValue(): Promise<string>;
  /**
   * Get the stored credentials, or prompt for and store them if absent.
   */
  getOrCreate(): Promise<T>;
  /** Prompt for fresh credentials and store them, replacing anything present. */
  createNew(): Promise<T>;
  /** Prompt to amend the stored credentials, keeping current values on empty input. */
  update(): Promise<T>;
  /** Discard the stored credentials. */
  clear(): Promise<void>;
  /** Whether credentials are currently stored. Never prompts. */
  hasCredentials(): Promise<boolean>;
}

// ── Logging ─────────────────────────────────────────────────────────

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

// ── Progress ────────────────────────────────────────────────────────

export interface ProgressTask<T> {
  execute: () => Promise<T>;
  description?: string;
}

export interface Progress {
  /**
   * Execute a list of tasks sequentially with progress indication.
   * Returns the collected results.
   */
  withProgress<T>(
    tasks: ProgressTask<T>[],
    options: { title: string; showItemCount?: boolean; cleanupMessage?: string }
  ): Promise<T[]>;
}

// ── Lock diagnostics ────────────────────────────────────────────────

/**
 * A process holding an open handle on a file.
 * @lastreviewed null
 */
export interface LockHolder {
  name: string;
  pid: number;
}

export interface LockDiagnoser {
  /**
   * Best-effort: the processes holding an open handle on `fsPath`. Returns
   * `[]` if unknown or unsupported on this platform. MUST NEVER throw — the
   * core layer calls this only to annotate an already-failing write, and a
   * diagnoser error must never mask the underlying file-system error.
   *
   * NOTE: a "no holder" result (`[]`) does not prove the file is unlocked. A
   * kernel filesystem minifilter (e.g. real-time AV / ransomware protection)
   * holds no user-mode handle and is therefore invisible to a handle-based
   * implementation — so an empty result is itself a minifilter fingerprint.
   * @lastreviewed null
   */
  diagnose(fsPath: string): Promise<LockHolder[]>;
}

// ── Aggregate ───────────────────────────────────────────────────────

/**
 * The complete set of platform abstractions required by the core layer.
 * Each consumer (VS Code extension, CLI, tests) provides its own implementations.
 */
export interface B6PProviders {
  fs: FileSystem;
  persistence: Persistence;
  prompt: Prompt;
  logger: Logger;
  progress: Progress;
  /** Optional debug-mode flag callback. Defaults to `() => false` if not provided. */
  isDebugMode?: () => boolean;
  /**
   * Optional authentication scheme. Defaults to `BearerAuthProvider` (this file
   * deliberately imports nothing from `auth/`, so that is a plain reference, not a
   * `{@link}`), built over the `persistence`, `prompt` and `logger` supplied above.
   *
   * Supply this to authenticate some other way — the core only ever asks for an
   * `Authorization` header value and drives the credential lifecycle through
   * {@link AuthProvider}, so the scheme itself is entirely the consumer's choice.
   */
  auth?: AuthProvider<AuthParams>;
  /**
   * Optional org-cache settings (provides override URLs for U values).
   * Defaults to a no-op implementation that returns `null` for all lookups.
   */
  orgCacheSettings?: OrgCacheSettings;
  /**
   * Optional low-level fetch function to use for the SessionManager. Defaults to
   * `globalThis.fetch`. Consumers (e.g. the VS Code extension) can pass a wrapped
   * fetch that adds proxy/cookie handling.
   */
  fetchFn?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /**
   * Optional directories that contain TypeScript's default library declaration
   * files (`lib.d.ts`, `lib.es2022.d.ts`, `lib.dom.d.ts`, ...). Used only by the
   * local transpile step that snapshot pushes run.
   *
   * WHY THIS EXISTS: b6p-core is bundled into the consumer (the CLI's single
   * `dist/cli.js` and its SEA binary). TypeScript's default host resolves the
   * standard library via `getDefaultLibLocation()` = `dirname(__filename)`. Once
   * bundled, `__filename` is the bundle path — where no `lib.*.d.ts` live — so
   * every compile fails with "File 'lib.esnext.d.ts' not found" cascading into
   * "Cannot find global type 'Array'". Because that resolution is unreliable
   * when bundled, the consumer should pass the directory it ships or extracts
   * these files to:
   *   - npm bundle: a `lib/` copied next to the bundle (e.g. by esbuild).
   *   - SEA binary: a temp dir the binary extracts its embedded libs into.
   * These are searched before the project-local `node_modules/typescript/lib`.
   * @lastreviewed null
   */
  typescriptLibDirs?: readonly string[];
  /**
   * Optional update service configuration. If not provided, update checking is disabled.
   */
  updateServiceConfig?: {
    currentVersion: string;
    repoOwner: string;
    repoName: string;
    enabled: boolean;
    versionOverride?: string;
  };
}
