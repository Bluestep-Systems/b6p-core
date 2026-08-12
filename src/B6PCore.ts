import { BearerAuthProvider } from "./auth/BearerAuthProvider";
import { SessionManager } from "./session/SessionManager";
import type { AuthProvider, B6PProviders, FileSystem, Logger, Persistence, Progress, Prompt } from "./providers";
import type { AuthParams } from "./types";
import { ScriptMetaDataStore } from "./cache/ScriptMetaDataStore";
import { OrgCache, type OrgCacheSettings } from "./cache/OrgCache";
import type { PlatformContext } from "./PlatformContext";
import { ScriptService } from "./script/ScriptService";
import { UpdateService } from "./update/UpdateService";

const NOOP_ORG_CACHE_SETTINGS: OrgCacheSettings = {
  getParsedAnyDomainOverrideUrl: () => null,
};

/**
 * Result returned by the report command.
 */
export interface ReportResult {
  metadataEntries: number;
  orgCacheEntries: number;
  details: string;
}

/**
 * Headless SDK entry point for the BlueStep platform.
 *
 * Consumers (VS Code extension, CLI, tests) construct this with their own
 * {@link B6PProviders} implementations, then reach the platform through it.
 *
 * This class is a **composition root**: it owns the platform-facing singletons
 * (auth, session, caches) and assembles the subsystem services that use them.
 * Script management lives behind {@link B6PCore.script}, not on this class —
 * `core.script.push(...)`, `core.script.pull(...)` — leaving room for further
 * subsystems (forms, users, reporting) to sit beside it without turning this into
 * a flat bag of every operation the platform supports.
 *
 * The five raw providers are **private on purpose**, and the reason is not
 * stylistic. Re-publishing them bought a consumer nothing — it already holds the
 * objects it passed in — while costing two things. First, a subsystem could then
 * reach `core.persistence` instead of receiving a bundle, which is exactly the
 * accretion {@link ScriptContext} was cleaned up to stop. Second, and worse, an
 * earlier revision of this comment claimed the class "deliberately does not
 * implement any of the interfaces it hands out" while `const ctx: ScriptContext =
 * core` still type-checked: dropping the `implements` clause removed the
 * declaration, not the structural conformance, because these fields supplied every
 * member. TypeScript is structural — the same trap `CLAUDE.md` documents for
 * `AuthParams`. Making them private is what makes the claim true instead of
 * decorative. Do not widen them back to `readonly`.
 *
 * This class contains zero `vscode.*` imports — all platform-specific
 * behaviour is delegated to the providers.
 * @lastreviewed null
 */
export class B6PCore {
  private readonly fs: FileSystem;
  private readonly persistence: Persistence;
  private readonly prompt: Prompt;
  private readonly logger: Logger;
  private readonly progress: Progress;

  readonly auth: AuthProvider<AuthParams>;
  readonly sessionManager: SessionManager;
  readonly scriptMetadataStore: ScriptMetaDataStore;
  readonly orgCache: OrgCache;
  readonly updateService: UpdateService | null = null;

  /**
   * Script management: push, pull, audit, deploy, and setup-URL resolution.
   * @lastreviewed null
   */
  readonly script: ScriptService;

  private readonly _isDebugMode: () => boolean;

  constructor(providers: B6PProviders) {
    this.fs = providers.fs;
    this.persistence = providers.persistence;
    this.prompt = providers.prompt;
    this.logger = providers.logger;
    this.progress = providers.progress;
    this._isDebugMode = providers.isDebugMode ?? (() => false);

    this.auth = providers.auth ?? new BearerAuthProvider(this.persistence, this.prompt, this.logger);
    this.sessionManager = new SessionManager(
      this.persistence,
      this.logger,
      this.auth,
      this._isDebugMode,
      this.prompt,
      providers.fetchFn
    );
    this.scriptMetadataStore = new ScriptMetaDataStore(this.persistence);
    this.orgCache = new OrgCache(
      this.persistence,
      this.logger,
      providers.orgCacheSettings ?? NOOP_ORG_CACHE_SETTINGS,
      this._isDebugMode,
      this.prompt
    );

    // The shared half of every subsystem's dependency bundle, built once. A second
    // service spreads this same object and adds only what is specific to it, so the
    // members below have one construction site rather than one per subsystem.
    // Absent by design: `auth` (only SessionManager consumes it) and `persistence`
    // (subsystems reach storage through the typed stores above, never the raw key
    // space).
    const platform: PlatformContext = {
      fs: this.fs,
      sessionManager: this.sessionManager,
      logger: this.logger,
      prompt: this.prompt,
      progress: this.progress,
      isDebugMode: this._isDebugMode,
    };

    this.script = new ScriptService({
      ...platform,
      scriptMetadataStore: this.scriptMetadataStore,
      orgCache: this.orgCache,
      typescriptLibDirs: providers.typescriptLibDirs,
    });

    // Initialize update service if configuration is provided
    if (providers.updateServiceConfig) {
      this.updateService = new UpdateService(
        this.persistence,
        this.logger,
        providers.updateServiceConfig,
        providers.fetchFn
      );
    }
  }

  isDebugMode(): boolean {
    return this._isDebugMode();
  }

  // ── Credentials ───────────────────────────────────────────────────

  async updateCredentials(): Promise<void> {
    await this.auth.update();
  }

  // ── Session Management ────────────────────────────────────────────

  async clearSessions(): Promise<void> {
    this.prompt.info("Clearing all sessions");
    await this.sessionManager.clearAll();
  }

  // ── Settings ──────────────────────────────────────────────────────

  async clearSettings(): Promise<void> {
    this.prompt.info("Reverting to default settings");
    await this.persistence.clearPublic();
  }

  async clearAll(): Promise<void> {
    this.prompt.info("Clearing sessions, auth, and settings");
    await this.persistence.clearPublic();
    await this.sessionManager.clearAll();
    await this.auth.clear();
  }

  // ── State ─────────────────────────────────────────────────────────

  async report(): Promise<ReportResult> {
    // Note: This is a basic implementation. Full functionality requires
    // Persistence to support listing keys by prefix.
    this.logger.info("Generating state report...");

    const details = [
      "Script Metadata and Org Cache reporting requires persistence layer",
      "to support key enumeration. This feature is pending full implementation.",
      "",
      "In the CLI, persistence is stored in .b6p/ directory.",
      "Use file system tools to inspect the raw JSON files for now.",
    ].join("\n");

    this.prompt.info(details);

    return {
      metadataEntries: 0,
      orgCacheEntries: 0,
      details,
    };
  }

  // ── Updates ───────────────────────────────────────────────────────

  async checkForUpdates(): Promise<void> {
    if (!this.updateService) {
      this.prompt.error("Update service is not configured");
      return;
    }

    this.logger.info("Checking for updates...");

    try {
      const updateInfo = await this.updateService.checkForUpdates();

      if (updateInfo) {
        this.prompt.info(
          `A new version is available!\n` +
            `Current: v${this.updateService.getCurrentVersion()}\n` +
            `Latest:  v${updateInfo.version}\n\n` +
            `Download from: ${updateInfo.downloadUrl}`
        );
      } else {
        this.prompt.info(`You are running the latest version (v${this.updateService.getCurrentVersion()})`);
      }
    } catch (error) {
      this.prompt.error(`Error checking for updates: ${error instanceof Error ? error.message : error}`);
    }
  }

  // ── Config Toggles ────────────────────────────────────────────────

  async setConfig(key: string, value: unknown): Promise<void> {
    await this.persistence.set(`settings.${key}`, value);
    this.prompt.info(`Set ${key} = ${JSON.stringify(value)}`);
  }

  async getConfig<T>(key: string): Promise<T | undefined> {
    return this.persistence.get<T>(`settings.${key}`);
  }

  /**
   * Dispose resources (session cleanup timer, etc.).
   */
  dispose(): void {
    this.sessionManager.dispose();
    this.orgCache.dispose();
  }
}
