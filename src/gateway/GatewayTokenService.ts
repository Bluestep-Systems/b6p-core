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
import type { GatewayClient } from "./GatewayClient";
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
    const what = `${Http.Methods.GET} ${Gateway.Paths.TOKENS}`;
    const body = await this.client.request(Http.Methods.GET, Gateway.Paths.TOKENS);
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
   * Mint a new token for the caller. The result holds the secret, which the gateway shows only
   * this once. `expiresAt` left out takes the gateway's default (90 days); `null` never expires.
   *
   * @throws {Err.GatewayInvalidArgumentError} before sending, for an empty or malformed alias or scope
   *   list, or an expiry that is not a date
   * @throws {Err.GatewayScopeEscalationError} a scope the presenting token lacks was asked for
   * @throws {Err.GatewayAliasTakenError} another of the caller's tokens has the alias
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
    return toMinted(answer, what, "the token may have been minted");
  }

  /**
   * Revoke one of the caller's tokens, by id or alias (resolved through {@link list} first).
   * Revoking the stored token is allowed: the result says `revokedCurrent: true`, and the stored
   * token is left in place for the consumer to deal with.
   *
   * @throws {Err.GatewayNotFoundError} no token of the caller's has that id or alias
   * @throws {Err.GatewayTokenAmbiguousError} it matches one token's id and another's alias
   * @lastreviewed null
   */
  async revoke(idOrAlias: string): Promise<GatewayTokenRevokeResult> {
    const target = await this.resolve(idOrAlias);
    await this.client.request(Http.Methods.DELETE, `${Gateway.Paths.TOKENS}/${encodeURIComponent(target.id)}`);
    return { id: target.id, alias: target.alias, revokedCurrent: target.current };
  }

  /**
   * Rotate one of the caller's tokens, by id or alias: the gateway atomically mints a replacement
   * with the same alias, scopes and lifetime policy and revokes the old one. When the rotated
   * token is the stored one, the replacement is stored in its place.
   *
   * @throws {Err.GatewayNotFoundError} no token of the caller's has that id or alias
   * @throws {Err.GatewayTokenAmbiguousError} it matches one token's id and another's alias
   * @throws {Err.GatewayTokenStoreError} the stored token was rotated (so it is already revoked) but
   *   its replacement could not be stored; the error carries the replacement, secret included
   * @lastreviewed null
   */
  async rotate(idOrAlias: string): Promise<GatewayTokenRotateResult> {
    const target = await this.resolve(idOrAlias);
    // What the rotate request will present; the store only replaces this exact value.
    const presenting = target.current ? await this.ctx.gatewayToken.token() : undefined;
    const path = `${Gateway.Paths.TOKENS}/${encodeURIComponent(target.id)}/rotate`;
    const answer = await this.client.request(Http.Methods.POST, path);
    const token = toMinted(answer, `${Http.Methods.POST} ${path}`, "the token may have been rotated");
    const replaced = { id: target.id, alias: target.alias };
    if (!target.current) {
      return { replaced, token, rotatedCurrent: false };
    }
    try {
      const problem = gatewayTokenProblem(token.token);
      if (problem) {
        throw new Error(`the replacement is not usable as a gateway token: ${problem}`);
      }
      if (presenting === undefined) {
        throw new Error("no stored token was read before the rotation");
      }
      await this.ctx.gatewayTokenStore.replace(presenting, token.token);
    } catch (error) {
      const why = redactToken(
        redactToken(error instanceof Error ? error.message : String(error), token.token),
        presenting
      );
      throw new Err.GatewayTokenStoreError(
        `The stored token "${target.alias}" was rotated and the old one is revoked, but the replacement could not be stored: ${why}`,
        token
      );
    }
    this.ctx.logger.info(`Rotated the stored gateway token "${target.alias}" and stored its replacement.`);
    return { replaced, token, rotatedCurrent: true };
  }

  /**
   * The one token of the caller's whose id or alias is `idOrAlias`.
   * @lastreviewed null
   */
  private async resolve(idOrAlias: string): Promise<GatewayTokenSummary> {
    if (typeof idOrAlias !== "string" || idOrAlias.length === 0) {
      throw new Err.GatewayInvalidArgumentError("No token id or alias was given.");
    }
    if (idOrAlias.startsWith(Gateway.TOKEN_PREFIX)) {
      // A pasted secret: never send it, and never quote it.
      throw new Err.GatewayInvalidArgumentError(
        `The value given as a token id or alias is shaped like a token secret (${Gateway.TOKEN_PREFIX}…); it was not sent.`
      );
    }
    const tokens = await this.list();
    const matches = tokens.filter((t) => t.id === idOrAlias || t.alias === idOrAlias);
    if (matches.length === 0) {
      throw new Err.GatewayNotFoundError(`No token of this user has the id or alias "${idOrAlias}".`, "not-found");
    }
    if (matches.length > 1) {
      const ids = matches.map((t) => t.id);
      throw new Err.GatewayTokenAmbiguousError(
        `"${idOrAlias}" is the id of one of this user's tokens and the alias of another (ids ${ids.join(", ")}).`,
        ids
      );
    }
    return matches[0];
  }
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
 * Parse a mint/rotate answer. The body holds a secret, so a failure never quotes it.
 * @lastreviewed null
 */
function toMinted(answer: JsonValue | undefined, what: string, consequence: string): GatewayMintedToken {
  if (isObject(answer)) {
    const id = idOf(answer.id);
    const { token, alias, scopes, expiresAt } = answer;
    if (
      id !== undefined &&
      typeof token === "string" &&
      token.length > 0 &&
      typeof alias === "string" &&
      isStringArray(scopes) &&
      isNullableString(expiresAt)
    ) {
      return { id, token, alias, scopes, expiresAt, neverExpires: expiresAt === null };
    }
  }
  throw unexpected(what, `is not the minted token the contract describes; ${consequence}`);
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
  if (alias.startsWith(Gateway.TOKEN_PREFIX)) {
    throw new Err.GatewayInvalidArgumentError(
      `The token's alias starts with ${Gateway.TOKEN_PREFIX}, which is reserved for token secrets; it was not sent.`
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
