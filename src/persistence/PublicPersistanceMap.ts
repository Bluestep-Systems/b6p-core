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
   * Creates an instance of PublicPersistanceMap.
   * @param key The key used for persisting the map.
   * @param persistence The persistence provider.
   */
  constructor(key: PublicKeys, persistence: IPersistence) {
    super(key, persistence);
    this.persistence.get<Record<string, T>>(this.key).then(data => {
      this.obj = revive(data || {});
      this.initialized = true;
    });
  }

  /**
   * Checks if the map has finished initializing.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Stores the current state of the map using the persistence provider.
   */
  override store(): Thenable<void> {
    return this.persistence.set(this.key, this.obj);
  }
}
