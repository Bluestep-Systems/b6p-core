import type { Persistence } from "../providers";

/**
 * The tail of each (persistence, key) mutation queue in this process, so two stores over the same
 * persistence object share one queue.
 * @lastreviewed null
 */
const QUEUES = new WeakMap<Persistence, Map<string, Promise<unknown>>>();

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
 * Read public state `key`, let `change` decide the new value, and write it, as one step: in this
 * process behind every earlier mutation of `key` on the same persistence object, and across
 * processes under {@link Persistence.withLock} when the persistence has it. The read happens inside
 * the lock, so a change another process made just before is never written over.
 * @lastreviewed null
 */
export function mutatePublic<R>(
  persistence: Persistence,
  key: string,
  change: (current: unknown) => Promise<PublicMutation<R>> | PublicMutation<R>
): Promise<R> {
  let queues = QUEUES.get(persistence);
  if (!queues) {
    queues = new Map();
    QUEUES.set(persistence, queues);
  }
  const step = async (): Promise<R> => {
    const outcome = await change(await persistence.get<unknown>(key));
    if (outcome.changed) {
      await persistence.set(key, outcome.next);
    }
    return outcome.result;
  };
  const locked = (): Promise<R> => (persistence.withLock ? persistence.withLock(key, step) : step());
  const tail = queues.get(key) ?? Promise.resolve();
  const run = tail.then(locked, locked);
  queues.set(
    key,
    run.catch(() => undefined)
  );
  return run;
}
