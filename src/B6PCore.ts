import * as path from 'path';
import { BasicAuthProvider } from './auth/BasicAuthProvider';
import { B6PUri } from './B6PUri';
import { ScriptUrlParser } from './data/ScriptUrlParser';
import { DownstairsPathParser } from './data/DownstairsPathParser';
import { SessionManager } from './session/SessionManager';
import type { B6PProviders, IFileSystem, ILogger, IPersistence, IProgress, IPrompt } from './providers';
import { executePush } from './push';
import { ScriptMetaDataStore } from './cache/ScriptMetaDataStore';
import { OrgCache, type IOrgCacheSettings } from './cache/OrgCache';
import type { ScriptContext } from './script/ScriptContext';
import { ScriptFactory } from './script/ScriptFactory';
import { UpdateService } from './update/UpdateService';

const NOOP_ORG_CACHE_SETTINGS: IOrgCacheSettings = {
  getParsedAnyDomainOverrideUrl: () => null,
};

/**
 * Result returned by the audit command.
 */
export interface AuditResult {
  changedFiles: string[];
  baseUrl: string;
}

/**
 * Result returned by the report command.
 */
export interface ReportResult {
  metadataEntries: number;
  orgCacheEntries: number;
  details: string;
}

/**
 * Headless orchestrator for all B6P operations.
 *
 * Consumers (VS Code extension, CLI, tests) construct this with their own
 * {@link B6PProviders} implementations, then call the command methods.
 *
 * This class contains zero `vscode.*` imports — all platform-specific
 * behaviour is delegated to the providers.
 */
export class B6PCore implements ScriptContext {
  readonly fs: IFileSystem;
  readonly persistence: IPersistence;
  readonly prompt: IPrompt;
  readonly logger: ILogger;
  readonly progress: IProgress;

  readonly auth: BasicAuthProvider;
  readonly sessionManager: SessionManager;
  readonly scriptMetadataStore: ScriptMetaDataStore;
  readonly orgCache: OrgCache;
  readonly updateService: UpdateService | null = null;
  private factory: ScriptFactory | null = null;
  private readonly _isDebugMode: () => boolean;
  constructor(providers: B6PProviders) {
    this.fs = providers.fs;
    this.persistence = providers.persistence;
    this.prompt = providers.prompt;
    this.logger = providers.logger;
    this.progress = providers.progress;
    this._isDebugMode = providers.isDebugMode ?? (() => false);

    this.auth = new BasicAuthProvider(this.persistence, this.prompt, this.logger);
    this.sessionManager = new SessionManager(
      this.persistence,
      this.logger,
      this.auth,
      this._isDebugMode,
      this.prompt,
      providers.fetchFn,
    );
    this.scriptMetadataStore = new ScriptMetaDataStore(this.persistence);
    this.orgCache = new OrgCache(
      this.persistence,
      this.logger,
      providers.orgCacheSettings ?? NOOP_ORG_CACHE_SETTINGS,
      this._isDebugMode,
      this.prompt,
    );

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

  public getScriptFactory() {
    if (!this.factory) {
      this.factory = new ScriptFactory(this);
    }
    return this.factory;
  }

  isDebugMode(): boolean {
    return this._isDebugMode();
  }

  /**
   * Create a ScriptUrlParser wired to this core's session and logger.
   */
  private createParser(url: string): ScriptUrlParser {
    return new ScriptUrlParser(url, this.sessionManager, this.logger, this.prompt);
  }

  /**
   * Derive the base WebDAV URL from a local file path by parsing the
   * downstairs path structure and looking up stored metadata.
   */
  private async deriveBaseUrl(filePath: string, _workspacePath: string): Promise<string | null> {
    try {
      const sf = this.getScriptFactory().createFile(B6PUri.fromFsPath(filePath));
      return sf.getScriptRoot().getBaseWebDavUrlString();
    } catch {
      this.logger.warn(`Could not parse downstairs path: ${filePath}`);
      return null;
    }
  }

  /**
   * Derive the workspace folder (parent of the org folder) from a file path
   * inside a script root. Returns null if the path can't be parsed.
   */
  deriveWorkspacePath(filePath: string): string | null {
    try {
      const sf = this.getScriptFactory().createFile(B6PUri.fromFsPath(filePath));
      return sf.getScriptRoot().getOrgUri().dirname.fsPath;
    } catch {
      return null;
    }
  }

  // ── Push / Pull ───────────────────────────────────────────────────

  async push(opts: {
    targetUrl?: string;
    rootPath: string;
    snapshot?: boolean;
    message?: string;
  }): Promise<void> {
    const targetUrl = opts.targetUrl ?? await this.prompt.inputBox({ prompt: 'Paste in the target formula URI' });
    if (targetUrl === undefined) {
      this.prompt.error('No target formula URI provided');
      return;
    }
    this.logger.info(`Pushing script from ${opts.rootPath} to ${targetUrl}${opts.snapshot ? ' (snapshot)' : ''}`);
    await executePush({
      ctx: this,
      progress: this.progress,
      targetUrl,
      rootPath: opts.rootPath,
      snapshot: opts.snapshot ?? false,
      message: opts.message,
    });
  }

  async pushCurrent(opts: {
    filePath: string;
    snapshot?: boolean;
    message?: string;
  }): Promise<void> {
    this.logger.info(`Push current for file: ${opts.filePath}`);
    const baseUrl = await this.deriveBaseUrl(opts.filePath, '');
    if (!baseUrl) {
      const url = await this.prompt.inputBox({ prompt: 'Could not determine script URL. Paste the target formula URI:' });
      if (!url) {return;}
      // Derive rootPath from the file's path structure
      const parser = new DownstairsPathParser(opts.filePath);
      await this.push({ targetUrl: url, rootPath: parser.getShavedName(), snapshot: opts.snapshot, message: opts.message });
      return;
    }
    const parser = new DownstairsPathParser(opts.filePath);
    await this.push({ targetUrl: baseUrl, rootPath: parser.getShavedName(), snapshot: opts.snapshot, message: opts.message });
  }

  async pull(opts: {
    formulaUrl?: string;
    workspacePath: string;
  }): Promise<void> {
    const formulaUrl = opts.formulaUrl ?? await this.prompt.inputBox({ prompt: 'Paste in the desired formula URL' });
    if (formulaUrl === undefined) {
      this.prompt.error('No formula URL provided');
      return;
    }
    this.logger.info(`Pulling script from ${formulaUrl} into ${opts.workspacePath}`);

    const parser = this.createParser(formulaUrl);
    const fetchedScriptObject = await parser.getScript();
    if (!fetchedScriptObject) {
      this.logger.warn('fetchedScriptObject is null');
      return;
    }

    const U = await parser.getU();
    const factory = this.getScriptFactory();

    const pullTasks = fetchedScriptObject.map(entry => ({
      execute: async () => {
        const ultimatePath = path.join(opts.workspacePath, U, entry.downstairsPath);
        const isDirectory = ultimatePath.endsWith('/') || entry.downstairsPath.endsWith('/');

        if (isDirectory) {
          const uri = B6PUri.fromFsPath(ultimatePath);
          if (!(await this.fs.exists(uri))) {
            await this.fs.createDirectory(uri);
          }
        } else {
          // Use ScriptFile.download() so that we get gitignore filtering, ETag-based
          // integrity verification, and `lastPulled` metadata tracking — all the
          // behaviour the previous inline fetch+writeFile loop was missing.
          const fileUri = B6PUri.fromFsPath(ultimatePath);
          const scriptRoot = factory.createScriptRoot(fileUri);
          scriptRoot.withParser(parser);
          const file = factory.createFile(fileUri, scriptRoot);
          // Make sure the parent directory exists before download writes the file.
          const parentUri = fileUri.dirname;
          if (!(await this.fs.exists(parentUri))) {
            await this.fs.createDirectory(parentUri);
          }
          await file.download(parser);
        }
        return ultimatePath;
      },
      description: 'scripts',
    }));

    await this.progress.withProgress(pullTasks, {
      title: 'Pulling Script...',
      cleanupMessage: 'Cleaning up the downstairs folder...',
    });

    this.prompt.info('Pull complete!');
  }

  async pullCurrent(opts: {
    filePath: string;
    workspacePath: string;
  }): Promise<void> {
    const baseUrl = await this.deriveBaseUrl(opts.filePath, opts.workspacePath);
    if (!baseUrl) {
      const url = await this.prompt.inputBox({ prompt: 'Could not determine script URL. Paste the formula URL:' });
      if (!url) {return;}
      await this.pull({ formulaUrl: url, workspacePath: opts.workspacePath });
      return;
    }
    await this.pull({ formulaUrl: baseUrl, workspacePath: opts.workspacePath });
  }

  // ── Audit ─────────────────────────────────────────────────────────

  async audit(opts: {
    filePath: string;
    workspacePath: string;
  }): Promise<AuditResult | null> {
    this.logger.info(`Auditing file: ${opts.filePath}`);

    const baseUrl = await this.deriveBaseUrl(opts.filePath, opts.workspacePath);
    if (!baseUrl) {
      const url = await this.prompt.inputBox({ prompt: 'Could not determine script URL. Paste the formula URL:' });
      if (!url) {return null;}
      return this.auditWithUrl(url, opts.workspacePath);
    }
    return this.auditWithUrl(baseUrl, opts.workspacePath);
  }

  private async auditWithUrl(baseUrl: string, workspacePath: string): Promise<AuditResult | null> {
    const parser = this.createParser(baseUrl);
    const fetchedScriptObject = await parser.getScript();
    if (!fetchedScriptObject) {
      this.logger.warn('fetchedScriptObject is null during audit');
      return null;
    }

    const U = await parser.getU();
    const changedFiles: string[] = [];
    const factory = this.getScriptFactory();

    for (const entry of fetchedScriptObject) {
      const ultimatePath = path.join(workspacePath, U, entry.downstairsPath);
      if (ultimatePath.endsWith('/') || entry.downstairsPath.endsWith('/')) {
        continue; // skip directories
      }
      const fileUri = B6PUri.fromFsPath(ultimatePath);
      if (!(await this.fs.exists(fileUri))) {
        changedFiles.push(entry.downstairsPath + ' (new)');
        continue;
      }
      // Use ScriptFile.currentIntegrityMatches() so that we get the same robust
      // ETag handling (standard / weak / numeric / complex) used by download().
      const scriptRoot = factory.createScriptRoot(fileUri);
      scriptRoot.withParser(parser);
      const file = factory.createFile(fileUri, scriptRoot);
      const upstairsOverride = new URL(entry.upstairsPath);
      const matches = await file.currentIntegrityMatches({ upstairsOverride });
      if (!matches) {
        changedFiles.push(entry.downstairsPath);
      }
    }

    if (changedFiles.length === 0) {
      this.prompt.info('No differences detected. Local script is in sync with the server.');
    } else {
      this.prompt.info(`Detected ${changedFiles.length} file(s) with differences:\n\n${changedFiles.join('\n')}`);
    }

    return { changedFiles, baseUrl };
  }

  async auditPull(opts: {
    filePath: string;
    workspacePath: string;
  }): Promise<void> {
    const result = await this.audit(opts);
    if (!result || result.changedFiles.length === 0) {
      return;
    }

    const YES = 'Sync';
    const NO = 'Cancel';
    const response = await this.prompt.confirm(
      `Detected ${result.changedFiles.length} file(s) with differences:\n\n${result.changedFiles.join('\n')}\n\nSync local copy with the server?`,
      [YES, NO]
    );

    if (response !== YES) {
      this.logger.info('User declined audit-pull sync');
      return;
    }

    await this.pull({ formulaUrl: result.baseUrl, workspacePath: opts.workspacePath });
  }

  // ── Deploy ────────────────────────────────────────────────────────

  async deploy(opts: {
    configPath: string;
  }): Promise<void> {
    this.logger.info(`Quick deploy from config: ${opts.configPath}`);

    // Read config file
    const configUri = B6PUri.fromFsPath(opts.configPath);
    if (!(await this.fs.exists(configUri))) {
      this.prompt.error(`Config file not found: ${opts.configPath}`);
      return;
    }

    const configContent = await this.fs.readFile(configUri);
    const configText = Buffer.from(configContent).toString('utf-8');

    interface DeployConfig {
      sourceRootPath: string;
      targets: Array<{
        url: string;
        snapshot?: boolean;
      }>;
    }

    let config: DeployConfig;
    try {
      config = JSON.parse(configText) as DeployConfig;
    } catch (error) {
      this.prompt.error(`Failed to parse config file: ${error instanceof Error ? error.message : error}`);
      return;
    }

    if (!config.sourceRootPath || !config.targets || config.targets.length === 0) {
      this.prompt.error('Invalid config file. Required fields: sourceRootPath, targets[]');
      return;
    }

    this.logger.info(`Deploying to ${config.targets.length} target(s)`);

    for (const target of config.targets) {
      this.logger.info(`Deploying to: ${target.url}`);
      try {
        await this.push({
          targetUrl: target.url,
          rootPath: config.sourceRootPath,
          snapshot: target.snapshot ?? false,
        });
      } catch (error) {
        this.logger.error(`Failed to deploy to ${target.url}: ${error instanceof Error ? error.message : error}`);
      }
    }

    this.prompt.info('Deploy complete!');
  }

  // ── Credentials ───────────────────────────────────────────────────

  async updateCredentials(): Promise<void> {
    await this.auth.update();
  }

  // ── Session Management ────────────────────────────────────────────

  async clearSessions(): Promise<void> {
    this.prompt.info('Clearing all sessions');
    await this.sessionManager.clearAll();
  }

  // ── Settings ──────────────────────────────────────────────────────

  async clearSettings(): Promise<void> {
    this.prompt.info('Reverting to default settings');
    await this.persistence.clearPublic();
  }

  async clearAll(): Promise<void> {
    this.prompt.info('Clearing sessions, auth, and settings');
    await this.persistence.clearPublic();
    await this.sessionManager.clearAll();
    await this.auth.clear();
  }

  // ── State ─────────────────────────────────────────────────────────

  async report(): Promise<ReportResult> {
    // Note: This is a basic implementation. Full functionality requires
    // IPersistence to support listing keys by prefix.
    this.logger.info('Generating state report...');

    const details = [
      'Script Metadata and Org Cache reporting requires persistence layer',
      'to support key enumeration. This feature is pending full implementation.',
      '',
      'In the CLI, persistence is stored in .b6p/ directory.',
      'Use file system tools to inspect the raw JSON files for now.',
    ].join('\n');

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
      this.prompt.error('Update service is not configured');
      return;
    }

    this.logger.info('Checking for updates...');

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

  // ── Setup URL ─────────────────────────────────────────────────────

  async getSetupUrl(opts: { filePath: string }): Promise<string | null> {
    try {
      const parser = new DownstairsPathParser(opts.filePath);
      const metadataKey = `scriptMeta.${parser.scriptName}`;
      const meta = await this.persistence.get<{ webdavUrl: string; classid: string; seqnum: string }>(metadataKey);

      if (!meta?.webdavUrl || !meta.classid || !meta.seqnum) {
        this.prompt.error(`No stored metadata found for script "${parser.scriptName}". Pull the script first.`);
        return null;
      }

      const origin = new URL(meta.webdavUrl).origin;

      // Build setup URL using ScriptKey pattern from the main codebase
      // Format: {origin}/shared/admin/applications/relate/{setupPage}?_event=edit&_id={classid__seqnum}
      const SCRIPT_TYPE_REGISTRY: Record<string, { setupPage: string }> = {
        "654015": { setupPage: "editformuladetails.jsp" },
        "530024": { setupPage: "editdetailreport1.jsp" },
        "363769": { setupPage: "editendpoint.jsp" },
      };

      const registry = SCRIPT_TYPE_REGISTRY[meta.classid];
      if (!registry) {
        this.prompt.error(`Unknown script type (classid: ${meta.classid}). Cannot generate setup URL.`);
        return null;
      }

      const compoundId = `${meta.classid}___${meta.seqnum}`;
      const setupUrl = `${origin}/shared/admin/applications/relate/${registry.setupPage}?_event=edit&_id=${compoundId}`;

      return setupUrl;
    } catch (error) {
      this.logger.error(`Error generating setup URL: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * Dispose resources (session cleanup timer, etc.).
   */
  dispose(): void {
    this.sessionManager.dispose();
    this.orgCache.dispose();
  }
}
