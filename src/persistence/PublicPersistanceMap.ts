import type { IPersistence } from "../providers";
import { PersistablePseudoMap } from "./PersistablePseudoMap";
import { PublicKeys } from "./PersistenceKeys";
import type { Serializable } from "./Serializable";
import { revive } from "./Serializable";

/**
 * A persistable map that uses the IPersistence interface to persist data.
 * Data is loaded asynchronously, so check `isInitialized()` before use.
 */
export class PublicPersistanceMap<T extends Serializable> extends PersistablePseudoMap<T> {
  protected initialized: boolean = false;

  /**
   * Resolves once the initial load from persistence has completed (successfully
   * or not). Callers that read the map synchronously (e.g. via {@link get}) must
   * await this first, otherwise they may observe an empty map before the
   * asynchronous constructor load has landed. Resolves — never rejects — so a
   * failed load leaves the map empty rather than hanging awaiters.
   * @lastreviewed null
   */
  private readonly ready: Promise<void>;

  /**
   * Creates an instance of PublicPersistanceMap.
   * @param key The key used for persisting the map.
   * @param persistence The persistence provider.
   */
  constructor(key: PublicKeys, persistence: IPersistence) {
    super(key, persistence);
    this.ready = this.persistence.get<Record<string, T>>(this.key).then(
      (data) => {
        this.obj = revive(data || {});
        this.initialized = true;
      },
      () => {
        // Leave the map empty on load failure; treated as "no data yet".
        // Still mark as initialized: the load has settled, so isInitialized()
        // must report true to stay consistent with the resolved `ready` promise.
        this.initialized = true;
      }
    );
  }

  /**
   * Checks if the map has finished initializing.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Awaits completion of the initial load from persistence. Safe to call
   * repeatedly; returns the same settled promise once loaded.
   * @returns A promise that resolves when the initial load has completed.
   * @lastreviewed null
   */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /**
   * Stores the current state of the map using the persistence provider.
   */
  override store(): PromiseLike<void> {
    return this.persistence.set(this.key, this.obj);
  }
}
