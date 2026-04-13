import { BlueHqAnyUrlResp, OrgCacheElement } from '../types';
import { BlueHQ, Http, Numerical } from "../constants";
import { OrgWorker } from "../data/OrgWorker";
import { HttpClient } from "../network/HttpClient";
import { Err } from "../Err";
import { PublicKeys, PublicPersistanceMap } from "../persistence";
import type { IPersistence, ILogger, IPrompt } from "../providers";

/**
 * Minimal settings shape required by {@link OrgCache}.
 *
 * Implementations may pull values from any backing store (VS Code config, env, file).
 */
export interface IOrgCacheSettings {
  /**
   * Returns an override URL for the given U if one is configured (e.g. via debug-mode
   * settings); returns `null` if no override applies.
   */
  getParsedAnyDomainOverrideUrl(u: string): URL | null;
}

/**
 * Disposable shape — local copy to avoid depending on the main-side Disposable type.
 */
export interface OrgCacheDisposable {
  dispose(): void;
}

/**
 * A cache of org URLs associated with U values.
 * @lastreviewed null
 */
export class OrgCache implements OrgCacheDisposable {
  private readonly orgCacheMap: PublicPersistanceMap<OrgCacheElement[]>;
  private _cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Optional callback invoked when the cache changes (e.g. for MCP server updates).
   */
  public onChanged: (() => void) | null = null;

  constructor(
    persistence: IPersistence,
    private readonly logger: ILogger,
    private readonly settings: IOrgCacheSettings,
    private readonly isDebugMode: () => boolean,
    private readonly prompt?: IPrompt,
  ) {
    this.orgCacheMap = new PublicPersistanceMap(PublicKeys.U_CACHE, persistence);
    this.cleanupOldEntries();
  }

  /** Gets the underlying persistence map. */
  public map(): PublicPersistanceMap<OrgCacheElement[]> {
    return this.orgCacheMap;
  }

  public async delete(u: string): Promise<void> {
    this.orgCacheMap.delete(u);
    await this.orgCacheMap.store();
    this.onChanged?.();
  }

  /** Cleans up entries that have not been accessed in the last 3 days. */
  private cleanupOldEntries() {
    const now = Date.now();
    const cutoff = now - Numerical.millisecondsInXDays(3);
    for (const [u, elementArray] of this.orgCacheMap) {
      const filteredArray = elementArray.filter(element => element.lastAccess >= cutoff);
      if (filteredArray.length === 0) {
        this.orgCacheMap.delete(u);
      } else if (filteredArray.length < elementArray.length) {
        this.orgCacheMap.set(u, filteredArray);
      }
    }
    this.orgCacheMap.store();
    this._cleanupTimer = setTimeout(() => this.cleanupOldEntries(), Numerical.millisecondsInXDays(1));
    // Don't keep the process alive just for cleanup (critical for the CLI).
    this._cleanupTimer.unref?.();
  }

  /** Validates the cache to ensure no duplicate hosts exist. */
  private cleanDuplicates(throwIfDuplicateExists = false) {
    const uniqueHosts = new Set<string>();
    for (const [u, elementArray] of this.orgCacheMap) {
      for (const element of elementArray) {
        if (uniqueHosts.has(element.host)) {
          if (throwIfDuplicateExists) {
            this.isDebugMode() && console.error(`OrgCache contains duplicate host ${element.host}`, this.orgCacheMap.toJSON());
            this.prompt?.error(`OrgCache is invalid!`);
            throw new Err.AlreadyAlertedError(`OrgCache contains duplicate host ${element.host}`);
          } else {
            this.orgCacheMap.delete(u);
            let foundU: string | null = null;
            while (foundU = this.findUCacheOnly(new URL(Http.Schemes.HTTPS + element.host))) {
              this.logger.info(`OrgCache contained duplicate host ${element.host}. Cleared U ${foundU}`);
              this.orgCacheMap.delete(foundU);
            }
            this.orgCacheMap.store();
            console.warn(`OrgCache contained duplicate host ${element.host}. Cleared all Us`);
          }
        }
        uniqueHosts.add(element.host);
      }
    }
  }

  /** Hard-validates all entries in the cache by calling the orgs to verify the U-host association. */
  public async hardValidateAll(): Promise<void> {
    this.cleanDuplicates(true);
    for (const u of this.orgCacheMap.keys()) {
      await this.hardValidateU(u);
    }
  }

  /** Hard-validates an individual U by ensuring each known host connects to the same U. */
  public async hardValidateU(u: string): Promise<void> {
    const elementArr = this.orgCacheMap.get(u);
    if (!elementArr) {
      return;
    }
    const removalSet = new Set<string>();
    for (const element of elementArr) {
      const orgWorker = OrgWorker.fromHost(element.host, HttpClient.getInstance().fetch.bind(HttpClient.getInstance()));
      if (!await orgWorker.verifyU(u)) {
        this.isDebugMode() && console.error(`OrgCache entry for U ${u} with host ${element.host} is invalid`, this.orgCacheMap.toJSON());
        removalSet.add(element.host);
      }
    }
    if (removalSet.size > 0) {
      const newElementArr = elementArr.filter(element => !removalSet.has(element.host));
      if (newElementArr.length === 0) {
        this.orgCacheMap.delete(u);
      } else {
        this.orgCacheMap.set(u, newElementArr);
      }
      await this.orgCacheMap.store();
    }
  }

  /**
   * Gets the first available URL associated with the given U from the cache.
   * If none exists, will call the BlueHQ helper to get any domain associated with the U.
   */
  public async getAnyBaseUrl(u: string): Promise<URL> {
    if (!/^U\d{6}$/.test(u)) {
      throw new Err.OrgCacheError("Invalid U format: " + u);
    }
    this.cleanDuplicates();
    // check cache first
    if (this.orgCacheMap.has(u)) {
      const cacheElement = this.orgCacheMap.get(u);
      if (cacheElement && cacheElement.length > 0) {
        return new URL(Http.Schemes.HTTPS + cacheElement[0].host);
      }
    }
    // check for overrides
    const overrideUrl = this.settings.getParsedAnyDomainOverrideUrl(u);
    if (overrideUrl) {
      return overrideUrl;
    }
    // finally we call the BlueHQ helper endpoint to do a hard-lookup
    const resp = await HttpClient.getInstance().fetch(BlueHQ.getAnyDomainUrl(u));
    if (!resp.ok) {
      throw new Err.BlueHqHelperEndpointError("Failed to fetch any domain from BlueHQ: " + resp.status + " " + resp.statusText);
    }
    const json = await resp.json() as BlueHqAnyUrlResp;
    const retUrl = new URL(json.orgUrl);
    this.orgCacheMap.set(u, [{ host: retUrl.host, lastAccess: Date.now() }]);
    this.onChanged?.();
    return retUrl;
  }

  /** Associates a host with a U value in the cache. */
  public async addHost(u: string, url: URL): Promise<void> {
    this.cleanDuplicates(false);
    const host = url.hostname;
    if (this.orgCacheMap.has(u)) {
      const elementArray = this.orgCacheMap.get(u);
      if (elementArray) {
        const existingElement = elementArray.find(element => element.host === host);
        if (!existingElement) {
          elementArray.push({ host, lastAccess: Date.now() });
          await this.orgCacheMap.set(u, elementArray);
          this.onChanged?.();
        } else {
          existingElement.lastAccess = Date.now();
          await this.orgCacheMap.set(u, elementArray);
        }
        return;
      }
    }
    await this.orgCacheMap.set(u, [{ host, lastAccess: Date.now() }]);
    this.onChanged?.();
  }

  /** Clears the entire cache. */
  public async clearCache(): Promise<void> {
    await this.orgCacheMap.clear();
    this.onChanged?.();
  }

  /**
   * Finds the U associated with the provided URL.
   * If not cached, will attempt to call the org to get the U.
   */
  public async findU(url: string | URL, cacheOnly = false): Promise<string> {
    url = new URL(url);
    const existingU = this.findUCacheOnly(url);
    if (existingU) {
      return existingU;
    } else if (cacheOnly) {
      throw new Err.OrgWorkerError(`No cached U found for URL: ${url.toString()}`);
    }
    const orgWorker = new OrgWorker(url, HttpClient.getInstance().fetch.bind(HttpClient.getInstance()));
    const U = await orgWorker.getU();
    await this.addHost(U, url);
    return U;
  }

  /** Finds the U associated with the provided URL from cache only. */
  public findUCacheOnly(url: URL): string | null {
    url = new URL(url);
    const newHostName = url.hostname;
    for (const [u, elementArray] of this.orgCacheMap) {
      for (const element of elementArray) {
        if (newHostName === element.host) {
          element.lastAccess = Date.now();
          this.orgCacheMap.set(u, elementArray);
          return u;
        }
      }
    }
    return null;
  }

  dispose() {
    if (this._cleanupTimer) {
      clearTimeout(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}
