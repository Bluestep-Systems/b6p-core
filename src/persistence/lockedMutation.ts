import type { Persistence } from "../providers";

/**
 * The tail of each (persistence, lock name) queue in this process, so two stores over the same
 * persistence object share one queue.
 * @lastreviewed null
 */
const QUEUES = new WeakMap<Persistence, Map<string, Promise<unknown>>>();

/**
 * Run `work` holding the lock called `name`: in this process behind every earlier holder of `name`
 * on the same persistence object, and across processes under {@link Persistence.withLock} when the
 * persistence has it. A failed turn does not stall the queue. Not re-entrant: `work` must not ask
 * for `name` again.
 * @lastreviewed null
 */
export function exclusive<T>(persistence: Persistence, name: string, work: () => Promise<T>): Promise<T> {
  let queues = QUEUES.get(persistence);
  if (!queues) {
    queues = new Map();
    QUEUES.set(persistence, queues);
  }
  const locked = (): Promise<T> => (persistence.withLock ? persistence.withLock(name, work) : work());
  const tail = queues.get(name) ?? Promise.resolve();
  const run = tail.then(locked, locked);
  queues.set(
    name,
    run.catch(() => undefined)
  );
  return run;
}

/**
 * What one {@link mutatePublic} change returns: the value to store (only when `changed`) and the
 * caller's result.
 * @lastreviewed null
 */
export interface PublicMutation<R> {
  readonly changed: boolean;
  readonly next?: unknown;
  readonly result: R;
}

/**
 * Read public state `key`, let `change` decide the new value, and write it, as one step under the
 * lock called `key` ({@link exclusive}). The read happens inside the lock, so a change another
 * process made just before is never written over.
 * @lastreviewed null
 */
export function mutatePublic<R>(
  persistence: Persistence,
  key: string,
  change: (current: unknown) => Promise<PublicMutation<R>> | PublicMutation<R>
): Promise<R> {
  return exclusive(persistence, key, async () => {
    const outcome = await change(await persistence.get<unknown>(key));
    if (outcome.changed) {
      await persistence.set(key, outcome.next);
    }
    return outcome.result;
  });
}
