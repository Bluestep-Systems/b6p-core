import { Gateway } from "../constants/Gateway";
import { Http } from "../constants/Http";
import { Err } from "../Err";
import type {
  GatewayMintedToken,
  GatewayTokenCreateRequest,
  GatewayTokenRevokeResult,
  GatewayTokenRotateResult,
  GatewayTokenSummary,
  JsonObject,
  JsonValue,
} from "../types";
import type { GatewayClient, GatewayRequestOptions } from "./GatewayClient";
import type { GatewayContext } from "./GatewayContext";
import { gatewayTokenProblem, redactToken } from "./GatewayToken";

/**
 * Whitespace or control characters; refused in an alias or a scope.
 * @lastreviewed null
 */
const BAD_CHARS = /[\s\u0000-\u001f\u007f]/;

/**
 * Self-service management of the caller's own gateway access tokens (`core.gateway.tokens`), per
 * the contract's §Tokens. Every route needs the `tokens:self` scope on the presenting token, which
 * is the one b6p has stored; nothing here addresses another user.
 *
 * Secrets: a minted secret is returned once, in the result, and never logged or put in an error
 * message. Every request goes through the gateway's one {@link GatewayClient}, so they stay
 * sequential with the rest of the gateway's traffic.
 *
 * There is still ONE stored token. {@link rotate} replaces it when the rotated token is the stored
 * one; {@link revoke} of the stored token leaves it in place (dead) and says so, and the consumer
 * decides what to do. Warning about and confirming a never-expiring token is the consumer's job;
 * results carry `neverExpires` so it can tell.
 * @lastreviewed null
 */
export class GatewayTokenService {
  constructor(
    private readonly client: GatewayClient,
    private readonly ctx: GatewayContext
  ) {}

  /**
   * The caller's tokens. `current` marks the one that made the request (the stored one).
   * @throws {Err.GatewayError} a subclass; `GatewayScopeError` with `scope: "tokens:self"` when the
   *   stored token may not manage tokens
   * @lastreviewed null
   */
  async list(): Promise<GatewayTokenSummary[]> {
    return listVia((method, path) => this.client.request(method, path));
  }

  /**
   * Mint a new token for the caller. The result holds the secret, which the gateway shows only
   * this once. `expiresAt` left out takes the gateway's default (90 days); `null` never expires.
   *
   * @throws {Err.GatewayInvalidArgumentError} before sending, for an empty or malformed alias or scope
   *   list, or an expiry that is not a date
   * @throws {Err.GatewayScopeEscalationError} a scope the presenting token lacks was asked for
   * @throws {Err.GatewayAliasTakenError} another of the caller's tokens has the alias
   * @throws {Err.GatewayOffContractTokenError} the token was minted but the answer was malformed;
   *   the error carries the secret
   * @lastreviewed null
   */
  async create(request: GatewayTokenCreateRequest): Promise<GatewayMintedToken> {
    checkAlias(request.alias);
    const scopes = checkScopes(request.scopes);
    const body: JsonObject = { alias: request.alias, scopes };
    if (request.expiresAt === null) {
      body.expiresAt = null;
    } else if (request.expiresAt !== undefined) {
      if (typeof request.expiresAt !== "string" || Number.isNaN(Date.parse(request.expiresAt))) {
        throw new Err.GatewayInvalidArgumentError("The token's expiry is not a date.");
      }
      body.expiresAt = request.expiresAt;
    }
    const what = `${Http.Methods.POST} ${Gateway.Paths.TOKENS}`;
    const answer = await this.client.request(Http.Methods.POST, Gateway.Paths.TOKENS, { body });
    const parsed = parseMinted(answer, what, "the token may have been minted");
    if (parsed.minted) {
      return parsed.minted;
    }
    throw new Err.GatewayOffContractTokenError(
      `${what}: a token was minted, but the gateway's answer describing it was malformed.`,
      "create",
      parsed.secret,
      false
    );
  }

  /**
   * Revoke one of the caller's tokens, by id or alias (resolved through the list first, in the
   * same queue entry and with the same token as the revoke).
   * Revoking the stored token is allowed: the result says `revokedCurrent: true`, and the stored
   * token is left in place for the consumer to deal with.
   *
   * @throws {Err.GatewayInvalidArgumentError} before sending, for an empty id-or-alias or one containing `b6pt_`
   * @throws {Err.GatewayNotFoundError} no token of the caller's has that id or alias
   * @throws {Err.GatewayTokenAmbiguousError} it matches one token's id and another's alias
   * @lastreviewed null
   */
  async revoke(idOrAlias: string): Promise<GatewayTokenRevokeResult> {
    const wanted = checkIdOrAlias(idOrAlias);
    // One queue entry and one token read: `current` describes the token the DELETE presents.
    return this.client.sequence(async (seq) => {
      const target = pick(await listVia(seq.request), wanted);
      await seq.request(Http.Methods.DELETE, `${Gateway.Paths.TOKENS}/${encodeURIComponent(target.id)}`);
      return { id: target.id, alias: target.alias, revokedCurrent: target.current };
    });
  }

  /**
   * Rotate one of the caller's tokens, by id or alias: the gateway atomically mints a replacement
   * with the same alias, scopes and lifetime policy and revokes the old one. When the rotated
   * token is the stored one, the replacement is stored in its place.
   *
   * The list, the rotate request and the store run as one entry in the client's queue and present
   * one read of the stored token, so nothing queued behind can present the revoked token, and the
   * store replaces exactly the token that was rotated. A secret the gateway returns is never
   * dropped, whatever fails after it arrives.
   *
   * @throws {Err.GatewayNotFoundError} no token of the caller's has that id or alias
   * @throws {Err.GatewayTokenAmbiguousError} it matches one token's id and another's alias
   * @throws {Err.GatewayTokenStoreError} the stored token was rotated (so it is already revoked) but
   *   its replacement could not be stored; the error carries the replacement, secret included
   * @throws {Err.GatewayOffContractTokenError} the token was rotated but the answer was malformed; the
   *   error carries the secret, and says whether it was stored (only tried for the stored token)
   * @lastreviewed null
   */
  async rotate(idOrAlias: string): Promise<GatewayTokenRotateResult> {
    const wanted = checkIdOrAlias(idOrAlias);
    // ONE queue entry for list + rotate + store, so no queued request runs between the gateway
    // revoking the old token and the replacement landing in the store; and ONE token read
    // (`seq.token()`), so `current`, the token the rotate presents and the store's `expected` agree.
    return this.client.sequence(async (seq) => {
      const target = pick(await listVia(seq.request), wanted);
      const path = `${Gateway.Paths.TOKENS}/${encodeURIComponent(target.id)}/rotate`;
      const what = `${Http.Methods.POST} ${path}`;
      const answer = await seq.request(Http.Methods.POST, path);
      const parsed = parseMinted(answer, what, "the token may have been rotated");
      const secret = parsed.minted ? parsed.minted.token : parsed.secret;
      const replaced = { id: target.id, alias: target.alias };

      if (!target.current) {
        if (!parsed.minted) {
          throw new Err.GatewayOffContractTokenError(
            `${what}: the token "${target.alias}" was rotated and the old one is revoked, but the gateway's answer describing the replacement was malformed. It is not the stored token, so nothing was stored.`,
            "rotate",
            secret,
            false
          );
        }
        return { replaced, token: parsed.minted, rotatedCurrent: false };
      }

      // The stored token is already revoked at the gateway: offer the secret to the store even
      // when the rest of the answer is off-contract, and never drop it.
      let storeFailure: string | undefined;
      try {
        const problem = gatewayTokenProblem(secret);
        if (problem) {
          throw new Error(`the replacement is not usable as a gateway token: ${problem}`);
        }
        await this.ctx.gatewayTokenStore.replace(await seq.token(), secret);
      } catch (error) {
        storeFailure = redactToken(
          redactToken(error instanceof Error ? error.message : String(error), secret),
          await seq.token()
        );
      }

      if (!parsed.minted) {
        const outcome =
          storeFailure === undefined
            ? "The replacement was stored in its place."
            : `The replacement could not be stored: ${storeFailure}`;
        throw new Err.GatewayOffContractTokenError(
          `${what}: the stored token "${target.alias}" was rotated and the old one is revoked, but the gateway's answer describing the replacement was malformed. ${outcome}`,
          "rotate",
          secret,
          storeFailure === undefined
        );
      }
      if (storeFailure !== undefined) {
        throw new Err.GatewayTokenStoreError(
          `The stored token "${target.alias}" was rotated and the old one is revoked, but the replacement could not be stored: ${storeFailure}`,
          parsed.minted
        );
      }
      this.ctx.logger.info(`Rotated the stored gateway token "${target.alias}" and stored its replacement.`);
      return { replaced, token: parsed.minted, rotatedCurrent: true };
    });
  }
}

/**
 * Sends one request; either the client's queued `request` or a {@link GatewaySequence}'s.
 * @lastreviewed null
 */
type Send = (method: string, path: string, options?: GatewayRequestOptions) => Promise<JsonValue | undefined>;

/**
 * `GET /api/v1/tokens`, parsed.
 * @lastreviewed null
 */
async function listVia(send: Send): Promise<GatewayTokenSummary[]> {
  const what = `${Http.Methods.GET} ${Gateway.Paths.TOKENS}`;
  const body = await send(Http.Methods.GET, Gateway.Paths.TOKENS);
  const tokens = isObject(body) ? body.tokens : undefined;
  if (!Array.isArray(tokens)) {
    throw unexpected(what, "is not the token list the contract describes");
  }
  return tokens.map((entry) => {
    const summary = toSummary(entry);
    if (!summary) {
      throw unexpected(what, "lists a token that is not shaped as the contract describes");
    }
    return summary;
  });
}

/**
 * Check an id-or-alias argument before anything is sent, and return it trimmed. A value that
 * contains `b6pt_` anywhere is taken for a pasted secret: refused, never sent, never quoted.
 * @lastreviewed null
 */
function checkIdOrAlias(idOrAlias: string): string {
  const wanted = typeof idOrAlias === "string" ? idOrAlias.trim() : "";
  if (wanted.length === 0) {
    throw new Err.GatewayInvalidArgumentError("No token id or alias was given.");
  }
  if (wanted.includes(Gateway.TOKEN_PREFIX)) {
    throw new Err.GatewayInvalidArgumentError(
      `The given id or alias contains ${Gateway.TOKEN_PREFIX}, so it looks like a token secret; it was not sent.`
    );
  }
  return wanted;
}

/**
 * The one token whose id or alias is `wanted`. Messages never quote `wanted`: it is user input,
 * and may be a secret the guard above did not recognise.
 * @lastreviewed null
 */
function pick(tokens: readonly GatewayTokenSummary[], wanted: string): GatewayTokenSummary {
  const matches = tokens.filter((t) => t.id === wanted || t.alias === wanted);
  if (matches.length === 0) {
    throw new Err.GatewayNotFoundError("No token of this user has the given id or alias.", "not-found");
  }
  if (matches.length > 1) {
    const ids = matches.map((t) => t.id);
    throw new Err.GatewayTokenAmbiguousError(
      `The given id or alias is the id of one of this user's tokens and the alias of another (ids ${ids.join(", ")}).`,
      ids
    );
  }
  return matches[0];
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: JsonValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isNullableString(value: JsonValue | undefined): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * The contract does not fix the id's JSON type; accept a string or a number and keep it as a string.
 * @lastreviewed null
 */
function idOf(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function toSummary(entry: JsonValue): GatewayTokenSummary | undefined {
  if (!isObject(entry)) {
    return undefined;
  }
  const id = idOf(entry.id);
  const { alias, scopes, createdAt, expiresAt, current } = entry;
  const lastUsedAt = entry.lastUsedAt ?? null;
  if (
    id === undefined ||
    typeof alias !== "string" ||
    !isStringArray(scopes) ||
    typeof createdAt !== "string" ||
    !isNullableString(expiresAt) ||
    !isNullableString(lastUsedAt) ||
    typeof current !== "boolean"
  ) {
    return undefined;
  }
  return {
    id,
    alias,
    scopes,
    createdAt,
    expiresAt,
    lastUsedAt,
    current,
    neverExpires: expiresAt === null,
  };
}

/**
 * A parsed mint/rotate answer: the full token, or, for an off-contract answer that still carried
 * a secret, the secret alone (which must never be dropped).
 * @lastreviewed null
 */
type ParsedMint = { minted: GatewayMintedToken; secret?: undefined } | { minted?: undefined; secret: string };

/**
 * Parse a mint/rotate answer. The body holds a secret, so a failure never quotes it. Throws
 * {@link Err.GatewayUnexpectedResponseError} only when the answer carries no secret at all.
 * @lastreviewed null
 */
function parseMinted(answer: JsonValue | undefined, what: string, consequence: string): ParsedMint {
  if (isObject(answer) && typeof answer.token === "string" && answer.token.length > 0) {
    const token = answer.token;
    const id = idOf(answer.id);
    const { alias, scopes, expiresAt } = answer;
    if (id !== undefined && typeof alias === "string" && isStringArray(scopes) && isNullableString(expiresAt)) {
      return { minted: { id, token, alias, scopes, expiresAt, neverExpires: expiresAt === null } };
    }
    return { secret: token };
  }
  throw unexpected(what, `is not the minted token the contract describes, and carries no token; ${consequence}`);
}

function unexpected(what: string, problem: string): Err.GatewayUnexpectedResponseError {
  return new Err.GatewayUnexpectedResponseError(`${what}: the gateway's answer ${problem}.`, null, null);
}

function checkAlias(alias: string): void {
  if (typeof alias !== "string" || alias.length === 0) {
    throw new Err.GatewayInvalidArgumentError("The token's alias is empty.");
  }
  if (BAD_CHARS.test(alias)) {
    throw new Err.GatewayInvalidArgumentError("The token's alias contains whitespace or control characters.");
  }
  if (alias.includes(Gateway.TOKEN_PREFIX)) {
    throw new Err.GatewayInvalidArgumentError(
      `The token's alias contains ${Gateway.TOKEN_PREFIX}, which is reserved for token secrets; it was not sent.`
    );
  }
}

function checkScopes(scopes: readonly string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Err.GatewayInvalidArgumentError("The token's scope list is empty.");
  }
  for (const scope of scopes) {
    if (typeof scope !== "string" || scope.length === 0 || BAD_CHARS.test(scope)) {
      throw new Err.GatewayInvalidArgumentError("A scope in the token's scope list is empty or contains whitespace.");
    }
  }
  return [...new Set(scopes)];
}
