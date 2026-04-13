import type { IPersistence } from "../providers";
import { TypedMap } from "./TypedMap";
import { Persistable } from "./Persistable";
import { PrivateKeys, PublicKeys } from "./PersistenceKeys";
import type { Serializable } from "./Serializable";
import { revive } from "./Serializable";

/**
 * A persistable version of {@link TypedMap} that automatically handles loading and storing
 * using the IPersistence interface.
 * @lastreviewed 2025-10-01
 */
export class TypedPersistable<T extends Record<string, Serializable>> extends TypedMap<T> implements Persistable {
  public readonly key: PublicKeys | PrivateKeys;
  protected persistence: IPersistence;
  protected initialized: boolean = false;

  constructor({key, persistence, defaultValue}: {key: PublicKeys | PrivateKeys, persistence: IPersistence, defaultValue: T}) {
    super();
    this.key = key;
    this.persistence = persistence;
    this.persistence.get<T>(this.key).then(data => {
      this.obj = revive(data || defaultValue);
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
   * Sets a value with type safety and automatic persistence.
   * @param key The key to set
   * @param value The value to set
   * @param update Whether to immediately store the updated map. This is primarily intended to allow you to await store() after multiple sets
   * so it doesn't get called multiple times in a row.
   * @returns This instance for chaining
   * @lastreviewed 2025-10-01
   */
  override async set<K extends keyof T & string>(key: K, value: T[K]): Promise<void>;
  override async set<K extends keyof T & string>(key: K, value: T[K], update: boolean = true): Promise<void> {
    super.set(key, value);
    update && this.store();
  }


  override toJSON(): string {
    return JSON.stringify(this.obj);
  }

  store(): Thenable<void> {
    return this.persistence.set(this.key, JSON.stringify(this.obj));
  }
}
