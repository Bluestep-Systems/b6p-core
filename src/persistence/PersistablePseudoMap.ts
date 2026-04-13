import type { IPersistence } from "../providers";
import { PseudoMap } from "./PseudoMap";
import { Persistable } from "./Persistable";
import type { Serializable } from "./Serializable";

/**
 * A persistable version of a pseudomap. Extending classes must implement an initializer
 * that will load the data from the appropriate source, and a storage method.
 *
 * Now uses IPersistence interface for storage, allowing the same persistence layer
 * to be shared between legacy extension code and the new B6PCore.
 */
export abstract class PersistablePseudoMap<T extends Serializable> extends PseudoMap<string, T> implements Persistable, Iterable<[string, T]> {

  /**
   * The key used for persisting the map.
   */
  readonly key: string;

  /**
   * The persistence provider (replaces direct vscode.ExtensionContext access).
   */
  protected readonly persistence: IPersistence;

  /**
   * Creates an instance of PersistableMap.
   * @param key The key used for persisting the map.
   * @param persistence The persistence provider.
   */
  constructor(key: string, persistence: IPersistence) {
    super();
    this.key = key;
    this.persistence = persistence;
  }

  /**
   * An iterator over the key-value pairs in the map.
   * @lastreviewed 2025-10-07
   */
  [Symbol.iterator](): Iterator<[string, T]> {
    return Object.entries(this.obj)[Symbol.iterator]();
  }

  /**
   * Sets the value associated with the given key. will also save the result when called
   * @lastreviewed 2025-10-07
   */
  override async set(key: string, value: T) {
    super.set(key, value);
    await this.store();
  }

  /**
   * Clears all entries in the map and persists the change.
   * @lastreviewed 2025-10-07
   */
  override async clear(): Promise<void> {
    super.clear();
    await this.store();
  }

  /**
   * Stores the current state of the of the map in the appropriate storage.
   */
  abstract store(): Thenable<void>;

  /**
   * produces a copy of the internal object.
   */
  toSavableObject(): Record<string, T> {
    return { ...this.obj };
  }
}
