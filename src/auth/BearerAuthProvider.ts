import type { BearerAuthParams } from "../types";
import { AuthTypes } from "../constants";
import type { AuthProvider, Logger, Persistence, Prompt } from "../providers";

const PERSISTENCE_KEY = "bearerAuth";

/**
 * Secret-storage key written by the removed `BasicAuthProvider`. Purged by
 * {@link BearerAuthProvider.clear} so an upgraded install does not leave a
 * stored username/password pair behind indefinitely.
 */
const LEGACY_BASIC_PERSISTENCE_KEY = "basicAuth";

/** The {@link AuthParams.scheme} discriminant for this provider's credentials. */
const BEARER_SCHEME = "bearer";

/**
 * Core-layer bearer auth provider.
 *
 * Holds a single opaque token, prompted from the user and kept in secret
 * storage. Credential prompting and storage are delegated to the provider
 * interfaces, so this class stays platform-free.
 */
export class BearerAuthProvider implements AuthProvider<BearerAuthParams> {
  constructor(
    private readonly persistence: Persistence,
    private readonly prompt: Prompt,
    private readonly logger: Logger
  ) {}

  /**
   * Returns the bearer auth header value (`"Bearer <token>"`).
   * Prompts for a token if none is stored.
   */
  async authHeaderValue(): Promise<string> {
    const { token } = await this.getOrCreate();
    return `${AuthTypes.BEARER_PREFIX}${token}`;
  }

  async getOrCreate(): Promise<BearerAuthParams> {
    const stored = await this.readStored();
    if (stored) {
      return stored;
    }
    this.prompt.info("No existing token found, please enter a new token.");
    return this.createNew();
  }

  /**
   * The stored credentials, or `undefined` if absent or unusable.
   *
   * Secret storage is shared with every other key the consumer keeps, and its
   * contents outlive any single version of this class, so what comes back is
   * parsed and checked rather than asserted. Anything that is not well-formed
   * `"bearer"` params is treated as absent, which routes the caller to a fresh
   * prompt instead of letting a malformed value reach the `Authorization`
   * header as `"Bearer undefined"`.
   */
  private async readStored(): Promise<BearerAuthParams | undefined> {
    const raw = await this.persistence.getSecret(PERSISTENCE_KEY);
    if (!raw) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn("Stored bearer credentials are not valid JSON; discarding them.");
      return undefined;
    }
    if (!this.isBearerAuthParams(parsed)) {
      this.logger.warn("Stored bearer credentials are malformed; discarding them.");
      return undefined;
    }
    return parsed;
  }

  private isBearerAuthParams(value: unknown): value is BearerAuthParams {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const candidate = value as Partial<BearerAuthParams>;
    return candidate.scheme === BEARER_SCHEME && typeof candidate.token === "string" && candidate.token.length > 0;
  }

  /**
   * Prompt for a new token and store it.
   *
   * An **empty** entry is treated as cancellation, not as a token. It has to be:
   * {@link isBearerAuthParams} rejects a zero-length token, so storing one produced a
   * credential this class would immediately discard — `hasCredentials()` returned
   * false right after a "Token stored" log line, and the next `authHeaderValue()`
   * re-prompted, giving a user who keeps pressing Enter an unbounded prompt loop.
   *
   * Note {@link update} deliberately reads empty as "keep the current token"; there
   * is no current token to keep here.
   * @lastreviewed null
   */
  async createNew(): Promise<BearerAuthParams> {
    const token = await this.prompt.inputBox({ prompt: "Enter your access token", password: true });
    if (token === undefined || token.length === 0) {
      throw new Error("Token entry cancelled");
    }
    const creds: BearerAuthParams = { scheme: BEARER_SCHEME, token };
    await this.persistence.setSecret(PERSISTENCE_KEY, JSON.stringify(creds));
    this.logger.info("Token stored");
    return creds;
  }

  /**
   * Update the stored token (prompts, keeps the old value on empty input).
   */
  async update(): Promise<BearerAuthParams> {
    const existing = await this.getOrCreate();
    const newToken = await this.prompt.inputBox({
      prompt: "Enter new access token (empty to keep current)",
      password: true,
    });
    if (newToken === undefined) {
      this.prompt.info("Cancelled");
      return existing;
    }
    const creds: BearerAuthParams = { scheme: BEARER_SCHEME, token: newToken || existing.token };
    await this.persistence.setSecret(PERSISTENCE_KEY, JSON.stringify(creds));
    if (creds.token === existing.token) {
      this.prompt.info("No changes made to the token.");
    } else {
      this.prompt.info("Token updated!");
    }
    return creds;
  }

  /**
   * Clear the stored token, along with any credentials left behind by the
   * removed basic-auth provider.
   */
  async clear(): Promise<void> {
    await this.persistence.deleteSecret(PERSISTENCE_KEY);
    await this.persistence.deleteSecret(LEGACY_BASIC_PERSISTENCE_KEY);
  }

  /**
   * Whether a usable token is currently stored.
   *
   * Agrees with {@link getOrCreate}: a stored value that would be discarded as
   * malformed reports `false`, so this never claims credentials that the next
   * `getOrCreate()` would throw away and re-prompt for.
   */
  async hasCredentials(): Promise<boolean> {
    return (await this.readStored()) !== undefined;
  }
}
