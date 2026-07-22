import type { ScriptMetaData } from "../types";
import { PublicKeys, PublicPersistanceMap } from "../persistence";
import type { IPersistence } from "../providers";

const STORE_KEY = "all";

/**
 * Persistent store for script metadata.
 *
 * Stores an array of {@link ScriptMetaData} objects via the persistence provider.
 * Lookup is done by U + webdavId or U + scriptName depending on what is available.
 *
 * NOTE: Legacy `.b6p_metadata.json` file migration is not handled here — that
 * code lives in the App-side bootstrap because it requires VS Code workspace APIs.
 */
export class ScriptMetaDataStore {
  private readonly metadataMap: PublicPersistanceMap<ScriptMetaData[]>;

  /** When true, upserts/removes mutate memory only and defer the disk write to {@link flush}. */
  private batching = false;
  /** Whether a deferred write is pending during a batch. */
  private pendingFlush = false;

  constructor(persistence: IPersistence) {
    this.metadataMap = new PublicPersistanceMap(PublicKeys.SCRIPT_METADATA, persistence);
  }

  /**
   * Begins a write-coalescing batch: subsequent {@link upsert} / {@link remove}
   * calls mutate the in-memory store but defer the disk write until
   * {@link flush} is called. Used to collapse the burst of per-script writes
   * during a pull into a single atomic write. Awaits the initial load first so
   * the coalesced write includes pre-existing entries instead of overwriting
   * them.
   */
  public async beginBatch(): Promise<void> {
    await this.metadataMap.whenReady();
    this.batching = true;
    this.pendingFlush = false;
  }

  /**
   * Ends a batch started by {@link beginBatch}, writing any deferred changes in
   * a single store. Safe to call when no batch is active or nothing changed —
   * it writes only when there is a pending change.
   */
  public async flush(): Promise<void> {
    const shouldWrite = this.batching && this.pendingFlush;
    this.batching = false;
    this.pendingFlush = false;
    if (shouldWrite) {
      await this.metadataMap.store();
    }
  }

  /**
   * Awaits the initial load from persistence. The synchronous read methods
   * ({@link all}, {@link findByScriptName}, …) observe an empty store until this
   * resolves, so async callers must await it before relying on a lookup.
   * @returns A promise that resolves when the store has finished loading.
   * @lastreviewed null
   */
  public whenReady(): Promise<void> {
    return this.metadataMap.whenReady();
  }

  /** Gets all stored metadata entries. */
  public all(): ScriptMetaData[] {
    return this.metadataMap.get(STORE_KEY) || [];
  }

  /** Finds metadata by U and webdavId. */
  public findByWebdavId(U: string, webdavId: string): ScriptMetaData | undefined {
    return this.all().find((m) => m.U === U && m.webdavId === webdavId);
  }

  /** Finds metadata by U and scriptName. */
  public findByScriptName(U: string, scriptName: string): ScriptMetaData | undefined {
    return this.all().find((m) => m.U === U && m.scriptName === scriptName);
  }

  /** Finds metadata using whatever identifiers are available; attempts by webdavId first */
  public find(criteria: { U: string; webdavId?: string; scriptName?: string }): ScriptMetaData | undefined {
    if (criteria.webdavId) {
      return this.findByWebdavId(criteria.U, criteria.webdavId);
    }
    if (criteria.scriptName) {
      return this.findByScriptName(criteria.U, criteria.scriptName);
    }
    return undefined;
  }

  /** Upserts a metadata entry. If an entry with matching U + webdavId exists, it is replaced. */
  public async upsert(metadata: ScriptMetaData): Promise<void> {
    const entries = this.all();
    const index = entries.findIndex((m) => m.U === metadata.U && m.webdavId === metadata.webdavId);
    if (index !== -1) {
      entries[index] = metadata;
    } else {
      entries.push(metadata);
    }
    await this.metadataMap.set(STORE_KEY, entries, !this.batching);
    if (this.batching) {
      this.pendingFlush = true;
    }
  }

  /**
   * Modifies metadata in-place via a callback function. Creates a new entry if none exists.
   * @returns The current or modified metadata object
   */
  public async modify(
    criteria: { U: string; webdavId: string },
    callBack?: (meta: ScriptMetaData) => void,
    defaults?: ScriptMetaData
  ): Promise<ScriptMetaData> {
    let entry = this.findByWebdavId(criteria.U, criteria.webdavId);
    let created = false;
    if (!entry) {
      if (!defaults) {
        throw new Error(
          `No metadata found for U=${criteria.U}, webdavId=${criteria.webdavId} and no defaults provided`
        );
      }
      entry = defaults;
      created = true;
    }
    if (callBack) {
      callBack(entry);
    }
    if (created || callBack) {
      await this.upsert(entry);
    }
    return entry;
  }

  /** Removes a metadata entry by U + webdavId. */
  public async remove(U: string, webdavId: string): Promise<void> {
    const entries = this.all().filter((m) => !(m.U === U && m.webdavId === webdavId));
    await this.metadataMap.set(STORE_KEY, entries, !this.batching);
    if (this.batching) {
      this.pendingFlush = true;
    }
  }
}
