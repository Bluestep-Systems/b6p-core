import type { IPersistence } from "../providers";
import { PersistablePseudoMap } from "./PersistablePseudoMap";
import { Persistable } from "./Persistable";
import { PrivateKeys } from "./PersistenceKeys";
import type { Serializable } from "./Serializable";
import { revive } from "./Serializable";
import { Err } from '../Err';

/**
 * A persistable map that uses the IPersistence interface for secret storage.
 * Data loaded is not immediately available upon construction, so any crucial data
 * you'll need to wait until `isInitialized()` returns true.
 */
export class PrivateGenericMap<T extends Serializable> extends PersistablePseudoMap<T> implements Persistable {

  protected initialized: boolean = false;

  /**
   * Creates an instance of PrivatePersistanceMap.
   * @param key The key used for persisting the map.
   * @param persistence The persistence provider.
   */
  constructor(key: PrivateKeys, persistence: IPersistence) {
    super(key, persistence);
    this.persistence.getSecret(this.key).then(jsonString => {
      this.obj = revive(JSON.parse(jsonString || '{}'));
      this.initialized = true;
    });
  }

  /**
   * Throws if the map is not fully initialized
   */
  private requiresInit() {
    if (!this.initialized) {
      throw new Err.PersistenceNotInitializedError("PrivatePersistanceMap", this.key);
    }
  }


  override get(key: string): T | undefined {
    this.requiresInit();
    return super.get(key);
  }


  override has(key: string): boolean {
    this.requiresInit();
    return super.has(key);
  }


  override async set(key: string, value: T) {
    this.requiresInit();
    super.set(key, value);
    return await this.store();
  }


  override forEach(callback: (value: T, key: string, map: this) => void): void {
    this.requiresInit();
    super.forEach(callback);
  }


  override delete(key: string) {
    this.requiresInit();
    super.delete(key);
    return this.store();
  }


  override async clear() {
    this.requiresInit();
    super.clear();
    return await this.store();
  }


  override store(): Thenable<void> {
    this.requiresInit();
    return this.persistence.setSecret(this.key, JSON.stringify(this.obj));
  }
}
