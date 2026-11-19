import { credentialHostOf } from "../gitCredential/hosts";
import { PublicKeys } from "../persistence/PersistenceKeys";
import type { Persistence } from "../providers";

/**
 * One recorded tenant host: when a script pull last reached its git proxy with the stored token.
 * @lastreviewed null
 */
interface RecordedHost {
  readonly recordedAt: number;
}

type RecordedHosts = Record<string, RecordedHost>;

function isRecordedHosts(value: unknown): value is RecordedHosts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (entry) => typeof entry === "object" && entry !== null && typeof (entry as RecordedHost).recordedAt === "number"
  );
}

/**
 * The tenant hosts b6p can `script pull` from: each one is recorded when a pull through that host's
 * git proxy succeeded with the stored token. Together with the gateway's host they are the hosts
 * {@link GitCredentialService} answers git's credential requests for.
 *
 * Core has no other source it could trust for this. The gateway does not list a token's tenant
 * hosts, the org cache forgets a host after three days unused, and no host rule (such as "any
 * `*.bluestep.net`") is taken on faith: a pull that worked is the proof.
 *
 * Every read and write goes to persistence, never to a copy held in memory, so a recording made by
 * another process (the extension beside the CLI, say) is seen and kept. Mutations through one
 * instance run one at a time; across processes the write is still last-writer-wins.
 * @lastreviewed null
 */
export class GitCredentialHosts {
  /**
   * The tail of this instance's mutations: each read-modify-write runs after the one before it, so two in flight
   * cannot each write over the other's change.
   * @lastreviewed null
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {}

  /**
   * The recorded hosts, sorted. A malformed stored value reads as none.
   * @lastreviewed null
   */
  async hosts(): Promise<string[]> {
    return [...(await this.read()).keys()].sort();
  }

  /**
   * Record the host of `url`, a URL a script pull just reached with the stored token. A URL that
   * is not https or carries credentials is not recorded.
   * @returns whether the host is now recorded
   * @lastreviewed null
   */
  async record(url: string | URL): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const host = credentialHostOf(parsed);
    if (host === null) {
      return false;
    }
    return this.mutate(async (recorded) => {
      recorded.set(host, { recordedAt: Date.now() });
      return true;
    });
  }

  /**
   * Forget `host`, so it is no longer answered for.
   * @returns whether it was recorded
   * @lastreviewed null
   */
  async forget(host: string): Promise<boolean> {
    return this.mutate(async (recorded) => recorded.delete(host));
  }

  /**
   * Runs one read-modify-write behind every earlier one on this instance, writing only when `change` reports a change.
   * @lastreviewed null
   */
  private mutate(change: (recorded: Map<string, RecordedHost>) => Promise<boolean>): Promise<boolean> {
    const run = this.tail.then(async () => {
      const recorded = await this.read();
      const changed = await change(recorded);
      if (changed) {
        await this.write(recorded);
      }
      return changed;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<Map<string, RecordedHost>> {
    const stored = await this.persistence.get<unknown>(PublicKeys.GIT_CREDENTIAL_HOSTS);
    return new Map(isRecordedHosts(stored) ? Object.entries(stored) : []);
  }

  private async write(recorded: Map<string, RecordedHost>): Promise<void> {
    const value: RecordedHosts = Object.fromEntries(recorded);
    await this.persistence.set(PublicKeys.GIT_CREDENTIAL_HOSTS, value);
  }
}
