/**
 * An interface for objects that can be persisted but must be manually stored.
 */
export interface Persistable {
  /**
   * Stores the current state of the object in the appropriate storage.
   */
  store(): Thenable<void>;
}
