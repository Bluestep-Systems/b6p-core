/**
 * A simple class that mimics the behavior of a Map, but uses a plain object underneath.
 */
export class PseudoMap<K extends string, V> {
  /**
   * The internal object storing key-value pairs.
   */
  protected obj: Record<K, V> = {} as Record<K, V>;

  /**
   * Creates an instance of PseudoMap.
   * @param initialData Optional initial data to populate the map.
   */
  constructor(initialData?: Record<K, V>) {
    if (initialData) {
      this.obj = initialData;
    }
  }

  /**
   * Retrieves the value associated with the given key.
   * @param key The key to look up.
   * @returns The value associated with the key, or undefined if not found.
   */
  get(key: K): V | undefined {
    return this.obj[key];
  }

  /**
   * Checks if a value is associated with the given key.
   * @param key The key to look up.
   * @returns True if a value is associated with the key, false otherwise.
   */
  has(key: K): boolean {
    return key in this.obj;
  }

  /**
   * Sets the value associated with the given key.
   * @param key The key to set.
   * @param value The value to associate with the key.
   * @returns The PseudoMap instance.
   */
  set(key: K, value: V): void {
    this.obj[key] = value;
  }

  /**
   * Executes a provided function once for each key-value pair in the map.
   * @param callback The function to execute for each entry.
   */
  forEach(callback: (value: V, key: string, map: this) => void): void {
    for (const key in this.obj) {
      callback(this.obj[key], key, this);
    }
  }

  /**
   * Deletes the value associated with the given key.
   * @param key The key to delete.
   * @returns The PseudoMap instance.
   */
  delete(key: K): void {
    delete this.obj[key];
  }

  /**
   * Clears all entries in the map.
   */
  clear(): void {
    this.obj = {} as Record<K, V>;
  }

  /**
   * Serializes the map to a JSON string.
   * @returns The JSON string representation of the map.
   */
  toJSON(): string {
    return JSON.stringify(this.obj);
  }

  /**
   * Keys of the PseudoMap.
   */
  keys(): K[] {
    return Object.keys(this.obj) as K[];
  }

  /**
   * Values of the PseudoMap.
   */
  values(): V[] {
    return Object.values(this.obj);
  }

  /**
   * Entries of the PseudoMap
   */
  entries(): [K, V][] {
    return Object.entries(this.obj) as [K, V][];
  }
}
