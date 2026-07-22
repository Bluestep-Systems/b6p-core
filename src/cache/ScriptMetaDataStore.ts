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

  /**
   * Nesting depth of active {@link beginBatch} calls. While > 0, upserts/removes
   * mutate memory only and defer the disk write. A depth counter (rather than a
   * boolean) keeps two overlapping batches from stranding each other's pending
   * writes — the coalesced write happens only when the outermost batch ends.
   * @lastreviewed null
   */
  private batchDepth = 0;
  /** Count of deferred writes not yet persisted within the current batch. */
  private pendingWrites = 0;

  /**
   * Upper bound on deferred writes before we flush mid-batch. Bounds how much
   * metadata a hard interrupt (SIGINT / crash, which bypasses {@link flush}) can
   * lose, while still collapsing the bulk of a pull's per-script write burst.
   * @lastreviewed null
   */
  private static readonly BATCH_FLUSH_THRESHOLD = 10;

  constructor(persistence: IPersistence) {
    this.metadataMap = new PublicPersistanceMap(PublicKeys.SCRIPT_METADATA, persistence);
  }

  private get batching(): boolean {
    return this.batchDepth > 0;
  }

  /**
   * Begins a write-coalescing batch: subsequent {@link upsert} / {@link remove}
   * calls mutate the in-memory store but defer the disk write until the matching
   * {@link flush}. Used to collapse the burst of per-script writes during a pull
   * into a single atomic write. Awaits the initial load first so the coalesced
   * write includes pre-existing entries instead of overwriting them. Nestable:
   * each `beginBatch` must be paired with a `flush`.
   * @lastreviewed null
   */
  public async beginBatch(): Promise<void> {
    await this.metadataMap.whenReady();
    this.batchDepth += 1;
  }

  /**
   * Ends a batch started by {@link beginBatch}. The deferred changes are written
   * in a single store when the outermost batch ends. Safe to call when nothing
   * changed — it writes only when there is a pending change. Flags are always
   * reset (even if the store throws) so a failed flush returns the store to
   * normal write-through mode rather than silently staying in batch mode.
   * @lastreviewed null
   */
  public async flush(): Promise<void> {
    if (this.batchDepth > 0) {
      this.batchDepth -= 1;
    }
    if (this.batchDepth > 0 || this.pendingWrites === 0) {
      return;
    }
    try {
      await this.metadataMap.store();
    } finally {
      this.pendingWrites = 0;
    }
  }

  /**
   * Persists the in-memory store mid-batch once enough writes have accumulated,
   * so a hard interrupt can't discard an unbounded amount of pulled metadata.
   * @lastreviewed null
   */
  private async maybeAutoFlush(): Promise<void> {
    if (this.pendingWrites < ScriptMetaDataStore.BATCH_FLUSH_THRESHOLD) {
      return;
    }
    try {
      await this.metadataMap.store();
    } finally {
      this.pendingWrites = 0;
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
      this.pendingWrites += 1;
      await this.maybeAutoFlush();
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
      this.pendingWrites += 1;
      await this.maybeAutoFlush();
    }
  }
}
