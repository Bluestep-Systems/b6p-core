import type { JsonValue } from '../types';

const SERIALIZABLE_TAG = '__serializable' as const;

/**
 * Interface for classes that can be serialized to JSON and revived back into class instances.
 *
 * Implementations must:
 * 1. Return a `{ __serializable: "<tag>", ...data }` object from `toJSON()`
 * 2. Register a reviver via {@link registerSerializable} so the persistence layer can reconstruct the instance on load
 */
export interface SerializableClass {
  toJSON(): { [SERIALIZABLE_TAG]: string;[key: string]: JsonValue; };
}

/**
 * Anything that can be persisted: plain {@link JsonValue} data, a class implementing {@link SerializableClass},
 * or arrays/objects whose values are themselves {@link Serializable}.
 */
export type Serializable =
  JsonValue
  | SerializableClass
  | Serializable[]
  | { [key: string]: Serializable; };

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type Reviver = (data: Record<string, JsonValue>) => SerializableClass;

const REGISTRY = new Map<string, Reviver>();

/**
 * Register a reviver for a {@link SerializableClass} tag.
 *
 * Call this once per class, typically at module scope:
 * ```ts
 * registerSerializable("ScriptKey", (d) => new ScriptKey(d.classid as string, d.seqnum as string));
 * ```
 */
export function registerSerializable(tag: string, reviver: Reviver): void {
  if (REGISTRY.has(tag)) {
    throw new Error(`Serializable tag "${tag}" is already registered`);
  }
  REGISTRY.set(tag, reviver);
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

/**
 * Recursively walks a deserialized value and revives any objects
 * carrying a `__serializable` tag back into their class instances.
 *
 * Called automatically by persistence map constructors after loading from storage.
 */
export function revive<T>(data: T): T {
  if (data === null || data === undefined || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      data[i] = revive(data[i]);
    }
    return data;
  }

  const obj = data as Record<string, unknown>;

  // Check if this object itself is a serializable class
  if (SERIALIZABLE_TAG in obj && typeof obj[SERIALIZABLE_TAG] === 'string') {
    const reviver = REGISTRY.get(obj[SERIALIZABLE_TAG] as string);
    if (reviver) {
      return reviver(obj as Record<string, JsonValue>) as T;
    }
  }

  // Walk nested values
  for (const key of Object.keys(obj)) {
    obj[key] = revive(obj[key]);
  }
  return data;
}
