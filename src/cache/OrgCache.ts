import { BlueHqAnyUrlResp, OrgCacheElement } from "../types";
import { BlueHQ, Http, Numerical } from "../constants";
import { OrgWorker } from "../data/OrgWorker";
import { HttpClient } from "../network/HttpClient";
import { Err } from "../Err";
import { PublicKeys, PublicPersistanceMap } from "../persistence";
import type { Persistence, Logger, Prompt } from "../providers";

/**
 * Minimal settings shape required by {@link OrgCache}.
 *
 * Implementations may pull values from any backing store (VS Code config, env, file).
 */
export interface OrgCacheSettings {
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
  private _disposed = false;

  /**
   * Optional callback invoked when the cache changes (e.g. for MCP server updates).
   */
  public onChanged: (() => void) | null = null;

  /**
   * Resolves once the backing map has loaded and the first cleanup pass has run.
   * Every public method that *reads or mutates the cache* awaits this first. The two
   * exceptions are deliberate: {@link map} hands out the backing map itself (its
   * caller owns the timing) and {@link dispose} must stay synchronous. Resolves —
   * never rejects — so a failed load leaves the cache empty rather than hanging
   * awaiters.
   * @lastreviewed null
   */
  private readonly ready: Promise<void>;

  constructor(
    persistence: Persistence,
    private readonly logger: Logger,
    private readonly settings: OrgCacheSettings,
    private readonly isDebugMode: () => boolean,
    private readonly prompt?: Prompt
  ) {
    this.orgCacheMap = new PublicPersistanceMap(PublicKeys.U_CACHE, persistence);
    // MUST await the load before the first cleanup. `PublicPersistanceMap` loads
    // asynchronously and *reassigns* its backing object when the load lands, so a
    // cleanup that ran synchronously here would iterate an empty map and then
    // `store()` that emptiness over the real file — silently wiping the persisted
    // cache on every construction, invisibly, because the in-memory copy arrives
    // immediately afterwards and looks correct for the rest of the session.
    this.ready = this.orgCacheMap
      .whenReady()
      .then(() => this.cleanupOldEntries())
      .catch((e) => {
        // Must not reject. `whenReady()` never does, but `cleanupOldEntries` reaches
        // `Persistence.set`, and a consumer implementation may throw synchronously.
        // Nothing awaits `ready` at construction time, so a rejection here would be
        // an unhandled rejection that takes the process down — and would then make
        // every gated method reject for the rest of the process's life.
        this.logger.warn(`OrgCache initial cleanup failed; continuing with the loaded cache: ${String(e)}`);
      });
  }

  /**
   * Awaits the initial load. Public methods do this for you; call it directly only
   * before {@link findUCacheOnly}, which is synchronous and cannot await.
   * @lastreviewed null
   */
  public whenReady(): Promise<void> {
    return this.ready;
  }

  /**
   * Gets the underlying persistence map. **Not gated on the initial load** — await
   * {@link whenReady} (or the map's own `whenReady()`) before reading from it.
   * @lastreviewed null
   */
  public map(): PublicPersistanceMap<OrgCacheElement[]> {
    return this.orgCacheMap;
  }

  public async delete(u: string): Promise<void> {
    await this.ready;
    this.orgCacheMap.delete(u);
    await this.orgCacheMap.store();
    this.onChanged?.();
  }

  /**
   * Cleans up entries that have not been accessed in the last 3 days, persists the
   * result if anything expired, then re-arms itself for a day later.
   *
   * **Async on purpose.** The `store()` used to be issued and dropped on the floor.
   * A rejected write was then an unhandled rejection — the `catch` on {@link ready}
   * did not cover it, because that only ever saw a *synchronous* throw, and the
   * timer-driven pass sat in no promise chain at all. Awaiting it also means
   * {@link whenReady} genuinely waits for the first write rather than resolving
   * while it is still in flight.
   *
   * The re-arm is in a `finally` so a transient write failure ends this pass, not
   * every future one.
   * @lastreviewed null
   */
  private async cleanupOldEntries(): Promise<void> {
    // The first sweep is deferred onto `ready`, so `dispose()` can land before this
    // ever runs — at which point `_cleanupTimer` was still null and dispose() found
    // nothing to clear. Without this guard the deferred sweep would then arm a timer
    // that re-arms itself forever, on an object its owner already disposed.
    if (this._disposed) {
      return;
    }
    try {
      const now = Date.now();
      const cutoff = now - Numerical.millisecondsInXDays(3);
      let changed = false;
      for (const [u, elementArray] of this.orgCacheMap) {
        const filteredArray = elementArray.filter((element) => element.lastAccess >= cutoff);
        if (filteredArray.length === 0) {
          this.orgCacheMap.delete(u);
          changed = true;
        } else if (filteredArray.length < elementArray.length) {
          // `update: false` — this set() would otherwise store() on the spot, and the
          // single write below would then be a second, redundant one.
          this.orgCacheMap.set(u, filteredArray, false);
          changed = true;
        }
      }
      // Only write when something actually expired. The old unconditional store()
      // rewrote the whole cache file on every construction, which on Windows is a
      // rapid-fire write that AV / ransomware heuristics penalise (see the retry
      // logic in SharedFilePersistence).
      if (changed) {
        await this.orgCacheMap.store();
        this.onChanged?.();
      }
    } finally {
      if (!this._disposed) {
        this._cleanupTimer = setTimeout(() => void this.runScheduledCleanup(), Numerical.millisecondsInXDays(1));
        // Don't keep the process alive just for cleanup (critical for the CLI).
        this._cleanupTimer.unref?.();
      }
    }
  }

  /**
   * Timer entry point for {@link cleanupOldEntries}. Nothing awaits the timer
   * callback, so this is where a failed scheduled sweep is absorbed — otherwise it
   * would surface as an unhandled rejection a day into a long-running host.
   * @lastreviewed null
   */
  private async runScheduledCleanup(): Promise<void> {
    try {
      await this.cleanupOldEntries();
    } catch (e) {
      this.logger.warn(`OrgCache scheduled cleanup failed; the cache is unchanged: ${String(e)}`);
    }
  }

  /**
   * Validates the cache to ensure no duplicate hosts exist.
   *
   * Async for the same reason {@link cleanupOldEntries} is: its `store()` was issued
   * and dropped, so a rejected write became an unhandled rejection. All three callers
   * are already async and now await it.
   * @lastreviewed null
   */
  private async cleanDuplicates(throwIfDuplicateExists = false): Promise<void> {
    const uniqueHosts = new Set<string>();
    for (const [u, elementArray] of this.orgCacheMap) {
      for (const element of elementArray) {
        if (uniqueHosts.has(element.host)) {
          if (throwIfDuplicateExists) {
            this.isDebugMode() &&
              console.error(`OrgCache contains duplicate host ${element.host}`, this.orgCacheMap.toJSON());
            this.prompt?.error(`OrgCache is invalid!`);
            throw new Err.AlreadyAlertedError(`OrgCache contains duplicate host ${element.host}`);
          } else {
            this.orgCacheMap.delete(u);
            let foundU: string | null = null;
            while ((foundU = this.findUCacheOnly(new URL(Http.Schemes.HTTPS + element.host)))) {
              this.logger.info(`OrgCache contained duplicate host ${element.host}. Cleared U ${foundU}`);
              this.orgCacheMap.delete(foundU);
            }
            await this.orgCacheMap.store();
            console.warn(`OrgCache contained duplicate host ${element.host}. Cleared all Us`);
          }
        }
        uniqueHosts.add(element.host);
      }
    }
  }

  /** Hard-validates all entries in the cache by calling the orgs to verify the U-host association. */
  public async hardValidateAll(): Promise<void> {
    await this.ready;
    await this.cleanDuplicates(true);
    for (const u of this.orgCacheMap.keys()) {
      await this.hardValidateU(u);
    }
  }

  /** Hard-validates an individual U by ensuring each known host connects to the same U. */
  public async hardValidateU(u: string): Promise<void> {
    await this.ready;
    const elementArr = this.orgCacheMap.get(u);
    if (!elementArr) {
      return;
    }
    const removalSet = new Set<string>();
    for (const element of elementArr) {
      const orgWorker = OrgWorker.fromHost(element.host, HttpClient.getInstance().fetch.bind(HttpClient.getInstance()));
      if (!(await orgWorker.verifyU(u))) {
        this.isDebugMode() &&
          console.error(`OrgCache entry for U ${u} with host ${element.host} is invalid`, this.orgCacheMap.toJSON());
        removalSet.add(element.host);
      }
    }
    if (removalSet.size > 0) {
      const newElementArr = elementArr.filter((element) => !removalSet.has(element.host));
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
    await this.ready;
    await this.cleanDuplicates();
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
      throw new Err.BlueHqHelperEndpointError(
        "Failed to fetch any domain from BlueHQ: " + resp.status + " " + resp.statusText
      );
    }
    const json = (await resp.json()) as BlueHqAnyUrlResp;
    const retUrl = new URL(json.orgUrl);
    this.orgCacheMap.set(u, [{ host: retUrl.host, lastAccess: Date.now() }]);
    this.onChanged?.();
    return retUrl;
  }

  /** Associates a host with a U value in the cache. */
  public async addHost(u: string, url: URL): Promise<void> {
    await this.ready;
    await this.cleanDuplicates(false);
    const host = url.hostname;
    if (this.orgCacheMap.has(u)) {
      const elementArray = this.orgCacheMap.get(u);
      if (elementArray) {
        const existingElement = elementArray.find((element) => element.host === host);
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
    await this.ready;
    await this.orgCacheMap.clear();
    this.onChanged?.();
  }

  /**
   * Finds the U associated with the provided URL.
   * If not cached, will attempt to call the org to get the U.
   */
  public async findU(url: string | URL, cacheOnly = false): Promise<string> {
    await this.ready;
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

  /**
   * Finds the U associated with the provided URL from cache only.
   *
   * Synchronous, so it cannot await the initial load itself. External callers must
   * `await orgCache.whenReady()` first; without that it reports a miss on a cache
   * that is merely not loaded yet, which an unlucky caller turns into a needless
   * BlueHQ round trip. Internal callers all run after {@link ready} has settled.
   * @lastreviewed null
   */
  public findUCacheOnly(url: URL): string | null {
    if (!this.orgCacheMap.isInitialized()) {
      this.logger.warn("OrgCache.findUCacheOnly called before the cache finished loading; reporting a miss.");
      return null;
    }
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
    this._disposed = true;
    if (this._cleanupTimer) {
      clearTimeout(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}
