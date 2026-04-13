import type { B6PUri } from './B6PUri';
import type { IOrgCacheSettings } from './cache/OrgCache';

// ── File System ─────────────────────────────────────────────────────

export interface FileStat {
  type: 'file' | 'directory';
  mtime: number;
  size: number;
}

export interface IFileSystem {
  readFile(uri: B6PUri): Promise<Uint8Array>;
  writeFile(uri: B6PUri, content: Uint8Array): Promise<void>;
  stat(uri: B6PUri): Promise<FileStat>;
  readDirectory(uri: B6PUri): Promise<[string, 'file' | 'directory'][]>;
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

export interface IPersistence {
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

export interface IPrompt {
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

export interface IAuth {
  /** Returns the value for the HTTP Authorization header. */
  authHeaderValue(): Promise<string>;
}

// ── Logging ─────────────────────────────────────────────────────────

export interface ILogger {
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

export interface IProgress {
  /**
   * Execute a list of tasks sequentially with progress indication.
   * Returns the collected results.
   */
  withProgress<T>(
    tasks: ProgressTask<T>[],
    options: { title: string; showItemCount?: boolean; cleanupMessage?: string }
  ): Promise<T[]>;
}

// ── Aggregate ───────────────────────────────────────────────────────

/**
 * The complete set of platform abstractions required by the core layer.
 * Each consumer (VS Code extension, CLI, tests) provides its own implementations.
 */
export interface B6PProviders {
  fs: IFileSystem;
  persistence: IPersistence;
  prompt: IPrompt;
  logger: ILogger;
  progress: IProgress;
  /** Optional debug-mode flag callback. Defaults to `() => false` if not provided. */
  isDebugMode?: () => boolean;
  /**
   * Optional org-cache settings (provides override URLs for U values).
   * Defaults to a no-op implementation that returns `null` for all lookups.
   */
  orgCacheSettings?: IOrgCacheSettings;
  /**
   * Optional low-level fetch function to use for the SessionManager. Defaults to
   * `globalThis.fetch`. Consumers (e.g. the VS Code extension) can pass a wrapped
   * fetch that adds proxy/cookie handling.
   */
  fetchFn?: (url: string | URL, init?: RequestInit) => Promise<Response>;
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
