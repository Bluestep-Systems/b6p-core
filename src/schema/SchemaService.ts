import { ApiEndpoints, Http, MimeTypes } from "../constants";
import { Err } from "../Err";
import type { SchemaApplyResult, SchemaRecipeName, SchemaRecipeResult, SchemaTestResult } from "../types";
import type { SchemaContext } from "./SchemaContext";

/**
 * Options of {@link SchemaService.generate}.
 * @lastreviewed null
 */
export interface SchemaGenerateOptions {
  /** Declare every object of a supported kind the named ones reference too; default `true` (the server's). @lastreviewed null */
  closure?: boolean;
  /** Generate a manifest holding no key, for applying in another tenant; default `false` (the server's). @lastreviewed null */
  portable?: boolean;
}

/**
 * Options of {@link SchemaService.test}.
 * @lastreviewed null
 */
export interface SchemaTestOptions {
  /**
   * Also report same-display-name collisions within a kind as warnings. Sent only when `true`, so a server that predates
   * the argument keeps working; a server that rejects it throws `Err.SchemaServerTooOldError`.
   * @lastreviewed null
   */
  verbose?: boolean;
}

/**
 * What {@link SchemaService.testThenApply} did.
 * @lastreviewed null
 */
export interface SchemaTestThenApplyResult {
  /** The dry run. @lastreviewed null */
  test: SchemaTestResult;
  /** The caller was shown a passing test and answered no, so nothing was applied. @lastreviewed null */
  declined: boolean;
  /** The apply's answer; `null` when the test did not pass (no key) or the caller declined. @lastreviewed null */
  apply: SchemaApplyResult | null;
}

/**
 * The GraphQL selection of a {@link SchemaApplyRefusal}.
 * @lastreviewed null
 */
const APPLY_REFUSAL_FIELDS = "code element detail";

/**
 * The GraphQL selection of a {@link SchemaTestResult}: every field.
 * @lastreviewed null
 */
const TEST_RESULT_FIELDS = `
  passed
  failedAt
  actions {
    element
    action
    objectId
    spec
    deltas { path kind from to livePositions }
    reasons { code detail }
  }
  refusals {
    stage
    code
    locus
    detail
    hits { objectId live }
  }
  schemaMutationKey
  refusal { ${APPLY_REFUSAL_FIELDS} }
  warnings { element detail }
`;

/**
 * The GraphQL selection of a {@link SchemaApplyResult}: every field.
 * @lastreviewed null
 */
const APPLY_RESULT_FIELDS = `
  applied
  objects { element objectId }
  refusal { ${APPLY_REFUSAL_FIELDS} }
  failedAt
  historyCommit
`;

/**
 * The GraphQL selection of a {@link SchemaRecipeResult}: every field.
 * @lastreviewed null
 */
const RECIPE_RESULT_FIELDS = `
  manifest
  findings { code severity subjectId fieldId formId detail }
`;

/**
 * The schema operation names, which a validation error naming one (or `verbose`) means the server does not know.
 * @lastreviewed null
 */
const SCHEMA_FEATURE_NAME = /\b(generateSchema|schemaRecipe|testSchema|applySchema|verbose)\b/;

/**
 * One entry of a GraphQL response's `errors`, as far as this service reads it.
 * @lastreviewed null
 */
interface GraphQlErrorEntry {
  message?: string;
  extensions?: { code?: string; classification?: string };
}

/**
 * A GraphQL response body, as far as this service reads it.
 * @lastreviewed null
 */
interface GraphQlResponseBody<T> {
  data?: T | null;
  errors?: GraphQlErrorEntry[];
}

/**
 * The schema subsystem, `core.schema`: generate, test and apply declarative manifests against one org. Every operation
 * is reserved to super users on the server (`Err.SchemaForbiddenError` otherwise). Requests go to the org's `/gql`
 * through the session manager, the same CSRF-managed path script code uses.
 *
 * Each method takes `org`: any URL on the org (its origin is used), the way other per-org calls take one.
 * @lastreviewed null
 */
export class SchemaService {
  constructor(private readonly ctx: SchemaContext) {}

  /**
   * The manifest describing the named objects as they stand now (GraphQL `generateSchema`).
   * @param org Any URL on the org; its origin is used
   * @param topIds Ids of the objects to describe
   * @returns The manifest, a YAML stream
   * @throws Err.SchemaForbiddenError when the caller is not a super user
   * @lastreviewed null
   */
  async generate(org: string | URL, topIds: readonly string[], options: SchemaGenerateOptions = {}): Promise<string> {
    const data = await this.post<{ generateSchema: string }>(
      org,
      "generateSchema",
      `query GenerateSchema($topIds: [ID!]!, $closure: Boolean!, $portable: Boolean!) {
        generateSchema(topIds: $topIds, closure: $closure, portable: $portable)
      }`,
      { topIds: [...topIds], closure: options.closure ?? true, portable: options.portable ?? false }
    );
    return data.generateSchema;
  }

  /**
   * Runs a recipe: an audit of the org stated as a manifest, with what it met (GraphQL `schemaRecipe`). Writes nothing.
   * @throws Err.SchemaForbiddenError when the caller is not a super user
   * @lastreviewed null
   */
  async recipe(org: string | URL, name: SchemaRecipeName): Promise<SchemaRecipeResult> {
    const data = await this.post<{ schemaRecipe: SchemaRecipeResult }>(
      org,
      "schemaRecipe",
      `query SchemaRecipe($name: SchemaRecipeName!) { schemaRecipe(name: $name) { ${RECIPE_RESULT_FIELDS} } }`,
      { name }
    );
    return data.schemaRecipe;
  }

  /**
   * Evaluates a manifest against the org as the caller, writing nothing (GraphQL `testSchema`). When every stage
   * passes the result carries the key {@link apply} needs. `verbose` is sent only when asked for.
   * @throws Err.SchemaForbiddenError when the caller is not a super user
   * @throws Err.SchemaServerTooOldError when `verbose` is asked for and the server does not know the argument
   * @lastreviewed null
   */
  async test(org: string | URL, manifest: string, options: SchemaTestOptions = {}): Promise<SchemaTestResult> {
    const verbose = options.verbose === true;
    const data = await this.post<{ testSchema: SchemaTestResult }>(
      org,
      "testSchema",
      verbose
        ? `mutation TestSchema($manifest: String!, $verbose: Boolean!) {
            testSchema(manifest: $manifest, verbose: $verbose) { ${TEST_RESULT_FIELDS} }
          }`
        : `mutation TestSchema($manifest: String!) { testSchema(manifest: $manifest) { ${TEST_RESULT_FIELDS} } }`,
      verbose ? { manifest, verbose } : { manifest }
    );
    return data.testSchema;
  }

  /**
   * Applies the plan a {@link test} approved (GraphQL `applySchema`): the manifest string that was tested, byte for
   * byte, and its key. The key is spent by the call whatever its outcome.
   *
   * The request is not retried: a retry after a lost answer would find the key spent and report `KEY_INVALID` for an
   * apply that may have committed. A transport failure here means the outcome is unknown; a fresh {@link test} then
   * plans to no change if the apply went through.
   * @throws Err.SchemaForbiddenError when the caller is not a super user
   * @lastreviewed null
   */
  async apply(org: string | URL, manifest: string, schemaMutationKey: string): Promise<SchemaApplyResult> {
    const data = await this.post<{ applySchema: SchemaApplyResult }>(
      org,
      "applySchema",
      `mutation ApplySchema($manifest: String!, $key: ID!) {
        applySchema(manifest: $manifest, schemaMutationKey: $key) { ${APPLY_RESULT_FIELDS} }
      }`,
      { manifest, key: schemaMutationKey },
      0
    );
    return data.applySchema;
  }

  /**
   * {@link test}, hand the result to `confirm`, and on a yes {@link apply} the same manifest string with the key the
   * test minted. Keeps "same bytes, same key" in one place. `confirm` is asked only when the test passed.
   * @lastreviewed null
   */
  async testThenApply(
    org: string | URL,
    manifest: string,
    confirm: (result: SchemaTestResult) => Promise<boolean>,
    options: SchemaTestOptions = {}
  ): Promise<SchemaTestThenApplyResult> {
    const test = await this.test(org, manifest, options);
    if (!test.passed || test.schemaMutationKey === null) {
      return { test, declined: false, apply: null };
    }
    if (!(await confirm(test))) {
      return { test, declined: true, apply: null };
    }
    return { test, declined: false, apply: await this.apply(org, manifest, test.schemaMutationKey) };
  }

  /**
   * Posts one operation to the org's `/gql` and returns its `data`.
   * @param operation The schema operation's name, for the error that names it
   * @param retries Passed to the session manager's retrying fetch; `0` for a request that must not be repeated
   * @throws Err.SchemaForbiddenError on `FORBIDDEN`
   * @throws Err.SchemaServerTooOldError when the server's validation rejects a schema operation or `verbose`
   * @throws Err.GraphQLError on any other GraphQL error
   * @throws Err.GraphQLFetchError on a non-OK answer that is no GraphQL answer, or one with no data
   * @lastreviewed null
   */
  private async post<T>(
    org: string | URL,
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    retries?: number
  ): Promise<T> {
    const url = new URL(org);
    url.pathname = ApiEndpoints.GQL;
    url.search = "";
    url.hash = "";
    const res = await this.ctx.sessionManager.csrfFetch(
      url,
      {
        method: Http.Methods.POST,
        headers: { [Http.Headers.CONTENT_TYPE]: MimeTypes.APPLICATION_JSON },
        body: JSON.stringify({ query, variables, operationName: operationNameOf(query) }),
      },
      retries
    );
    const text = await res.text();
    let body: GraphQlResponseBody<T>;
    try {
      body = JSON.parse(text) as GraphQlResponseBody<T>;
    } catch {
      throw new Err.GraphQLFetchError(`${operation}: HTTP ${res.status} with no JSON body: ${text.substring(0, 500)}`);
    }
    if (body.errors !== undefined && body.errors.length > 0) {
      if (body.errors.some((e) => codeOf(e) === "FORBIDDEN")) {
        throw new Err.SchemaForbiddenError(operation);
      }
      const tooOld = body.errors.find(
        (e) => codeOf(e) === "ValidationError" && SCHEMA_FEATURE_NAME.test(e.message ?? "")
      );
      if (tooOld !== undefined) {
        const feature = /\bverbose\b/.test(tooOld.message ?? "") ? "testSchema's verbose argument" : operation;
        throw new Err.SchemaServerTooOldError(feature, tooOld.message ?? "");
      }
      throw new Err.GraphQLError(body.errors);
    }
    if (!res.ok || body.data === undefined || body.data === null) {
      throw new Err.GraphQLFetchError(`${operation}: HTTP ${res.status} ${res.statusText} with no data`);
    }
    return body.data;
  }
}

/**
 * The code of a GraphQL error: the server's `extensions.code`, else graphql-java's `extensions.classification`.
 * @lastreviewed null
 */
function codeOf(error: GraphQlErrorEntry): string | undefined {
  return error.extensions?.code ?? error.extensions?.classification;
}

/**
 * The operation name a query document declares (`query Name`, `mutation Name`).
 * @lastreviewed null
 */
function operationNameOf(query: string): string {
  const match = /^\s*(?:query|mutation)\s+(\w+)/.exec(query);
  if (match === null) {
    throw new Error("schema operation without a name");
  }
  return match[1];
}
