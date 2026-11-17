import type { SchemaApplyResult, SchemaRecipeName, SchemaRecipeResult, SchemaTestResult } from "../types";
import type { SchemaContext } from "./SchemaContext";

/**
 * Options of {@link SchemaService.generate}.
 * @lastreviewed null
 */
export interface SchemaGenerateOptions {
  /** Declare every object of a supported kind the named ones reference too; the server's default is `true`. @lastreviewed null */
  closure?: boolean;
  /** Generate a manifest holding no key, for applying in another tenant; the server's default is `false`. @lastreviewed null */
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
 * The schema subsystem, `core.schema`: generate, test and apply declarative manifests against one org. Every operation
 * is reserved to super users on the server.
 * @lastreviewed null
 */
export class SchemaService {
  constructor(private readonly ctx: SchemaContext) {}

  /**
   * The manifest describing the named objects as they stand now (GraphQL `generateSchema`).
   * @param org Any URL on the org; its origin is used
   * @param topIds Ids of the objects to describe
   * @returns The manifest, a YAML stream
   * @lastreviewed null
   */
  async generate(org: string | URL, topIds: readonly string[], options: SchemaGenerateOptions = {}): Promise<string> {
    void this.ctx;
    void org;
    void topIds;
    void options;
    throw new Error("SchemaService.generate is not implemented yet");
  }

  /**
   * Runs a recipe: an audit of the org stated as a manifest, with what it met (GraphQL `schemaRecipe`).
   * @lastreviewed null
   */
  async recipe(org: string | URL, name: SchemaRecipeName): Promise<SchemaRecipeResult> {
    void org;
    void name;
    throw new Error("SchemaService.recipe is not implemented yet");
  }

  /**
   * Evaluates a manifest against the org as the caller, writing nothing (GraphQL `testSchema`). When every stage
   * passes the result carries the key {@link apply} needs.
   * @lastreviewed null
   */
  async test(org: string | URL, manifest: string, options: SchemaTestOptions = {}): Promise<SchemaTestResult> {
    void org;
    void manifest;
    void options;
    throw new Error("SchemaService.test is not implemented yet");
  }

  /**
   * Applies the plan a {@link test} approved (GraphQL `applySchema`): the manifest string that was tested, byte for
   * byte, and its key. The key is spent by the call whatever its outcome.
   * @lastreviewed null
   */
  async apply(org: string | URL, manifest: string, schemaMutationKey: string): Promise<SchemaApplyResult> {
    void org;
    void manifest;
    void schemaMutationKey;
    throw new Error("SchemaService.apply is not implemented yet");
  }

  /**
   * {@link test}, hand the result to `confirm`, and on a yes {@link apply} the same manifest with the key the test
   * minted. Keeps "same bytes, same key" in one place. `confirm` is not asked when the test did not pass.
   * @lastreviewed null
   */
  async testThenApply(
    org: string | URL,
    manifest: string,
    confirm: (result: SchemaTestResult) => Promise<boolean>,
    options: SchemaTestOptions = {}
  ): Promise<SchemaTestThenApplyResult> {
    void org;
    void manifest;
    void confirm;
    void options;
    throw new Error("SchemaService.testThenApply is not implemented yet");
  }
}
