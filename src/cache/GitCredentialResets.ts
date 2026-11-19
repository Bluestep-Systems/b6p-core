import { configPathKey, type ConfigPathStyle } from "../gitCredential/credentialConfig";
import { exclusive, mutatePublic } from "../persistence/lockedMutation";
import { PublicKeys } from "../persistence/PersistenceKeys";
import type { Persistence } from "../providers";

/**
 * Where b6p's reset under one key in one file stands. b6p writes its reset and its helper as one
 * pair, in one edit of the file, and removes the pair the same way, so the file never holds one
 * without the other.
 *
 * - `installed`: b6p wrote the pair. It stays b6p's only while `helper` directly follows an empty
 *   value among that key's values in that file; once it does not (the user took b6p's helper out,
 *   say), b6p drops the record and claims nothing.
 * - `adding`: b6p is about to append the pair; the key then had `pairsBefore` such pairs in the
 *   file. Settled as not done when it still has that many, as `installed` when it has one more, and
 *   as `unconfirmed` otherwise.
 * - `unconfirmed`: the file does not show which pair is b6p's. Nothing is removed for it; the next
 *   setup or removal that covers the key reports it and forgets it.
 * @lastreviewed null
 */
export type GitCredentialResetState = "installed" | "adding" | "unconfirmed";

/**
 * b6p's reset under one exact key in one file.
 * @lastreviewed null
 */
export interface GitCredentialResetRecord {
  readonly state: GitCredentialResetState;
  /**
   * The helper command written straight after the reset.
   * @lastreviewed null
   */
  readonly helper: string;
  /**
   * For `adding`: how many reset-then-`helper` pairs the key had in the file just before.
   * @lastreviewed null
   */
  readonly pairsBefore?: number;
}

/**
 * Every record: file path (one spelling per file: the first b6p recorded, as git reported it) →
 * exact config key (as written, case kept) → record.
 * @lastreviewed null
 */
export type GitCredentialResetsByFile = Record<string, Record<string, GitCredentialResetRecord>>;

const STATES: ReadonlySet<string> = new Set(["installed", "adding", "unconfirmed"]);

function isRecord(value: unknown): value is GitCredentialResetRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as GitCredentialResetRecord;
  if (!STATES.has(r.state) || typeof r.helper !== "string") {
    return false;
  }
  return r.state === "adding"
    ? Number.isInteger(r.pairsBefore) && (r.pairsBefore ?? -1) >= 0
    : r.pairsBefore === undefined;
}

// The spelling `file` is stored under in `all`: the one already there for the same file, else `file`.
function spellingIn(all: GitCredentialResetsByFile, file: string, style: ConfigPathStyle): string {
  const want = configPathKey(file, style);
  return Object.keys(all).find((known) => configPathKey(known, style) === want) ?? file;
}

// The valid records, two spellings of one file (C:/Users/… and C:\Users\… on Windows) merged under the first.
function clean(stored: unknown, style: ConfigPathStyle): GitCredentialResetsByFile {
  const out: GitCredentialResetsByFile = {};
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return out;
  }
  for (const [file, keys] of Object.entries(stored)) {
    if (typeof keys !== "object" || keys === null) {
      continue;
    }
    for (const [key, record] of Object.entries(keys)) {
      if (isRecord(record)) {
        const spelling = spellingIn(out, file, style);
        (out[spelling] ??= {})[key] ??= record;
      }
    }
  }
  return out;
}

/**
 * The name of the lock every setup and removal of b6p's git config entries holds from start to
 * end ({@link GitCredentialResets.exclusive}).
 * @lastreviewed null
 */
export const GIT_CONFIG_LOCK = "b6p:git_credential_config";

/**
 * Which `helper =` resets in the user's git config b6p wrote, so removal takes out only those and
 * never one the user wrote, whatever sits next to it. Public state `b6p:git_credential_resets`:
 * `{ "<file>": { "<exact key>": { state, helper, pairsBefore? } } }`.
 *
 * An addition is written here before it is made (`adding`) and again after it, so
 * a run that stopped between the two is settled by the next one from the file
 * ({@link GitCredentialResetState}). Each write is a locked read-modify-write
 * ({@link mutatePublic}), and the whole of a setup or removal runs inside {@link exclusive}.
 *
 * A file is recorded under one spelling: every write for another spelling of the same file (by
 * `pathStyle`, as `configPathKey` compares them) goes to the one already recorded, so recording,
 * settling and removal always meet the same entry.
 *
 * The record outlives `clearSettings()` and `clearAll()` (see `B6PCore`), because the entries it
 * describes stay in the user's git config until a removal takes them out.
 * @lastreviewed null
 */
export class GitCredentialResets {
  constructor(
    private readonly persistence: Persistence,
    private readonly pathStyle: ConfigPathStyle = process.platform === "win32" ? "win32" : "posix"
  ) {}

  /**
   * Every record, read under the record's lock, so a write of it (or `B6PCore`'s clear, which keeps
   * it) is never seen halfway.
   * @lastreviewed null
   */
  async all(): Promise<GitCredentialResetsByFile> {
    return exclusive(this.persistence, PublicKeys.GIT_CREDENTIAL_RESETS, async () =>
      clean(await this.persistence.get<unknown>(PublicKeys.GIT_CREDENTIAL_RESETS), this.pathStyle)
    );
  }

  /**
   * Replace the record for `key` in `file`; `undefined` removes it.
   * @lastreviewed null
   */
  async put(file: string, key: string, record: GitCredentialResetRecord | undefined): Promise<void> {
    await mutatePublic(this.persistence, PublicKeys.GIT_CREDENTIAL_RESETS, (current) => {
      const all = clean(current, this.pathStyle);
      file = spellingIn(all, file, this.pathStyle);
      const keys = { ...(all[file] ?? {}) };
      if (record === undefined) {
        delete keys[key];
      } else {
        keys[key] = record;
      }
      if (Object.keys(keys).length === 0) {
        delete all[file];
      } else {
        all[file] = keys;
      }
      return { changed: true, next: all, result: undefined };
    });
  }

  /**
   * Run `work` holding the git config lock ({@link GIT_CONFIG_LOCK}): in this process after every
   * earlier holder on the same persistence object, and across processes under
   * `Persistence.withLock` when the persistence has it. One setup or removal holds it from reading
   * the config to settling the last record, so two never interleave.
   * @lastreviewed null
   */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    return exclusive(this.persistence, GIT_CONFIG_LOCK, work);
  }
}
