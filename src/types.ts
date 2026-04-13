import type { ScriptKey } from './data/ScriptKey';

/**
 * A map-like interface that only allows read operations.
 */
export interface ReadOnlyMap<T> {
  get(key: string): T | undefined;
  has(key: string): boolean;
  forEach(callback: (value: T, key: string, map: this) => void): void;
}

/**
 * A JSON-compatible primitive value.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * A JSON-compatible array.
 */
export type JsonArray = JsonValue[];

/**
 * A JSON-compatible object.
 */
export type JsonObject = { [key: string]: JsonValue; };

/**
 * A plain JSON-compatible value: a primitive, an array of JSON values, or an object of JSON values.
 *
 * By design, this should be a value such that it can round-trip through JSON without loss:
 * ```typescript
 * Util.deepEquals(JSON.parse(JSON.stringify(obj)), obj) === true
 * ```
 *
 * @example
 * const example1: JsonValue = 42;
 * const example2: JsonValue = [1, "two", false, null];
 * const example3: JsonValue = { k1: "v1", k2: 2, k3: [true, 5], k4: { nestedKey: "something" } };
 */
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

/**
 * A nested object where all values are primitives or other nested objects.
 *
 * @example
 * const example1: PrimitiveNestedObject = { k1: "value", k2: 42, k3: true };
 * const example2: PrimitiveNestedObject = { nested: { k1: "value" }, k2: 100 };
 * const example3: PrimitiveNestedObject = { k1: null, k2: { k3: false } };
 */
export type PrimitiveNestedObject = {
  [key: string]: JsonPrimitive | PrimitiveNestedObject;
};

/**
 * The structure of a WebDAV XML response.
 */
export type XMLResponse = {
  "?xml": {
    "@version"?: string;
    "@encoding"?: string;
  };
  "D:multistatus": {
    "D:response": { //TODO this may not actually return an array every time. Needs more investigation
      "D:href": string;
      "D:propstat": {
        "D:status": string;
        "D:prop": {
          "D:creationdate"?: string;
          "D:displayname"?: string;
          "D:getlastmodified"?: string;
          "D:lockdiscovery"?: unknown;
          "D:resourcetype"?: {
            "D:collection"?: unknown;
          };
          "D:supportedlock"?: {
            "D:lockentry": {
              "D:lockscope": {
                "D:exclusive": string;
              };
              "D:locktype": {
                "D:write": string;
              };
            };
          };
          "D:getcontentlength"?: string;
        };
      };
    }[];
  };
};

/**
 * data requisite to manage an individual login session
 */
export type SessionData = {

  /**
   * timestamp of the last time this session was used
   */
  lastTouched: number;

  /**
   * the JSESSIONID cookie value used by tomcat to identify the session
   */
  JSESSIONID: string | null;

  /**
   * the INGRESSCOOKIE cookie value used by the ingress controller to identify the session
   */
  INGRESSCOOKIE: string | null;

  /**
   * the last CSRF token received from the server
   */
  lastCsrfToken: string | null;
};

/**
 * Basic auth information.
 */
export type BasicAuthParams = {
  username: string;
  password: string;
};

/**
 * GQL response for script queries, either "good" or "bad".
 */
export type ScriptGqlResp = ScriptGQLGoodResp | ScriptGQLBadResp;

/**
 * how a GQL response looks when it is "good"
 * 
 * //TODO this is incomplete for every GQL query possible. This should be tied to specific queries
 */
export type ScriptGQLGoodResp = {
  "data": {
    "children": [
      {
        "children": {
          "items": [
            {
              "id": string;
            }
          ];
        };
      }
    ];
  };
};

/**
 * how a GQL response looks when there were errors with the query
 */
export type ScriptGQLBadResp = {
  "errors": [
    {
      "message": string;
    }
  ];
};

/**
 * Options needed to to override the source in a script operation.
 */
export type SourceOps = { sourceOrigin: string, topId: string; };

/**
 * The metadata for the Script objects used locally.
 * //TODO: we should eventually
 */
export type ScriptMetaData = {

  /**
   * The WebDAV ID extracted from the file path.
   */
  webdavId: string;

  /**
   * The name of the script.
   */
  scriptName: string;

  /**
   * the org's seqnum
   */
  U: string;

  /**
   * the script's unique key (seqnum and classid pair).
   *
   * Automatically hydrated into a {@link ScriptKey} instance by the persistence layer
   * via the `__storable` tag; serialized back to plain JSON via {@link ScriptKey.toJSON}.
   */
  scriptKey: ScriptKey;

  /**
   * push/pull records for the script.
   */
  pushPullRecords: {

    /**
     * actual location of the file locally
     */
    downstairsPath: string;

    /**
     * the hash of the file when it was last verified (after a push or pull)
     */
    lastVerifiedHash: string | null;
  }[];

};
/**
 * This is the content of a metadata.json found in every script folder.
 *
 * It is used to store various metadata about the script.
 * 
 * //TODO this is incomplete and is not correct for all Script types
 */
export type MetaDataDotJsonContent = {
  /**
   * //TODO
   */
  displayName: string;
  /**
   * //TODO
   */
  description: string;
  /**
   * //TODO
   */
  _postAncestorId: string;
  /**
   * //TODO
   */
  disabled: boolean;
  /**
   * //TODO
   */
  frozen: boolean;
  /**
   * //TODO
   */
  fixedId: string;
  /**
   * this is a newline separated list of key=value altids
   * @example
   * altIds: "FID=value1\nSID=value2\nGID=value3"
   */
  altIds: string;
  /**
   * //TODO
   */
  path: string;
  /**
   * //TODO
   */
  deniedIPs: string;
  /**
   * //TODO
   */
  allowedIPs: string;
  /**
   * //TODO
   */
  IPFilterExemptGroupKey: string;
  /**
   * //TODO
   */
  IPFilterPermissionOption: "Error";
  /**
   * //TODO
   */
  basicPermissionOption: "Error";
  /**
 * //TODO
 */
  httpOption: "HttpsRedirect" | "HttpsOnly" | "HttpAndHttps";
  /**
   * //TODO
   */
  allowedMethods?: string[];
};

/**
 * propagation behavior options for scripts
 */
type PropagationBehaviorTypes = "MANDATORY" | "NESTED" | "NEVER" | "NOT_SUPPORTED" | "REQUIRED" | "REQUIRES_NEW" | "SUPPORTS";

/**
 * sandbox size options for scripts
 * 
 * see platform documentation for details
 */
type SandboxSizes =
  "XXX_SMALL"
  | "XX_SMALL"
  | "X_SMALL"
  | "SMALL"
  | "MEDIUM_SMALL"
  | "MEDIUM"
  | "MEDIUM_LARGE"
  | "LARGE"
  | "X_LARGE"
  | "XX_LARGE"
  | "XXX_LARGE"
  | "UNLIMITED";

/**
 * This is the content of a config.json found in every script folder.
 */
export type ConfigJsonContent = {

  /**
   * the main script file to execute (relative to the script folder)
   * 
   * technically this can be any path but by convention it is always "../scripts/app"
   */
  main: "../scripts/app",

  /**
   * propagation behavior for this script
   */
  propagationBehavior: PropagationBehaviorTypes,

  /**
   * //TODO
   */
  transactionReadonly: boolean,

  /**
   * //TODO
   */
  transactionTimeout: string | number,

  /**
   * sandbox size
   */
  sandbox: SandboxSizes,

  /**
   * //TODO
   */
  expiresBy: string,

  /**
   * "Local external" modules
   */
  models?: {
    name: string,
    url: string;
  }[],

  /**
   * //TODO
   */
  language: "mjs",

  /**
   * //TODO
   */
  scriptlibrary: "private";
};

// NOTE: UpdateInfo, ClientInfo, and GithubRelease previously lived here as
// duplicates of the canonical definitions in ./update/types.ts. They have been
// removed from this file during the workspaces split — import them from
// '@bluestep-systems/b6p-core' (which re-exports the canonical versions) or
// directly from './update/types'.

/**
 * The settings used by the extension.
 */
export type Settings = {
  /**
   * Whether debug mode is enabled.
   */
  debugMode: {
    /**
     * Whether debug mode is enabled.
     */
    enabled: boolean;

    /**
     * If in debug mode, the URLs to use for anyDomain lookups instead of the actual domain.
     */
    anyDomainOverrideUrl: string;

    /**
     * If set, this version string will override the actual extension version for update checks.
     */
    versionOverride: string;
  };
  
  /**
   * Settings related to update checks.
   */
  updateCheck: {
    /**
     * Whether update checks are enabled.
     */
    enabled: boolean;
    /**
     * Whether to show notifications about updates.
     */
    showNotifications: boolean;
  };

  /**
   * Settings for which popups to squelch
   */
  /**
   * Whether advanced features are shown.
   */
  advancedMode: {
    /**
     * Whether advanced mode is enabled.
     */
    enabled: boolean;
  };

  squelch: {
    /**
     * the pull-complete notification
     */
    pullComplete: boolean;
    /**
     * the push-complete notification
     */
    pushComplete: boolean;
  }

  /**
   * Settings for the local script root directory.
   */
  scriptRoot: {
    /**
     * The absolute path to the local folder where scripts are pulled into.
     * If empty, defaults to the first workspace folder.
     */
    path: string;
  }
};

/**
 * TypeScript configuration options (tsconfig.json structure).
 * 
 * @see https://www.typescriptlang.org/tsconfig
 */
export type TsConfig = {
  /**
   * Compiler options that control how TypeScript compiles your code.
   */
  compilerOptions: {
    // Language and Environment
    /** Target JavaScript version (ES3, ES5, ES2015, ES2017, ES2018, ES2019, ES2020, ES2021, ES2022, ESNext) */
    target?: string;
    /** Module system (CommonJS, AMD, UMD, System, ES6, ES2015, ES2020, ES2022, ESNext, Node16, NodeNext) */
    module?: string;
    /** Built-in library files to include (ES5, ES2015, DOM, WebWorker, etc.) */
    lib?: string[];
    /** Allow JavaScript files to be compiled */
    allowJs?: boolean;
    /** Report errors in .js files */
    checkJs?: boolean;

    // Emit
    /** Generate .d.ts declaration files */
    declaration?: boolean;
    /** Generate source map files */
    sourceMap?: boolean;
    /** Output directory for compiled files */
    outDir?: string;
    /** Root directory of source files */
    rootDir?: string;
    /** Remove comments from output */
    removeComments?: boolean;
    /** Don't emit files if any type checking errors are reported */
    noEmitOnError?: boolean;
    /** Don't emit any files */
    noEmit?: boolean;
    /** Preserve const enums in generated code */
    preserveConstEnums?: boolean;
    /** Generate .d.ts.map files for declaration files */
    declarationMap?: boolean;

    // Type Checking - Strict Checks
    /** Enable all strict type checking options */
    strict?: boolean;
    /** Raise error on expressions and declarations with an implied 'any' type */
    noImplicitAny?: boolean;
    /** Enable strict null checks */
    strictNullChecks?: boolean;
    /** Enable strict checking of function types */
    strictFunctionTypes?: boolean;
    /** Enable strict 'bind', 'call', and 'apply' methods on functions */
    strictBindCallApply?: boolean;
    /** Enable strict checking of property initialization in classes */
    strictPropertyInitialization?: boolean;
    /** Raise error on 'this' expressions with an implied 'any' type */
    noImplicitThis?: boolean;
    /** Enable error reporting for codepaths that do not explicitly return in a function */
    noImplicitReturns?: boolean;
    /** Enable error reporting for fallthrough cases in switch statements */
    noFallthroughCasesInSwitch?: boolean;
    /** Include 'undefined' in index signature results */
    noUncheckedIndexedAccess?: boolean;

    // Type Checking - Additional Checks
    /** Report errors on unused locals */
    noUnusedLocals?: boolean;
    /** Report errors on unused parameters */
    noUnusedParameters?: boolean;
    /** Disable error reporting for unused labels */
    allowUnusedLabels?: boolean;
    /** Disable error reporting for unreachable code */
    allowUnreachableCode?: boolean;

    // Modules
    /** Allow importing .json files */
    resolveJsonModule?: boolean;
    /** Allow 'import x from y' when a module doesn't have a default export */
    allowSyntheticDefaultImports?: boolean;
    /** Emit additional JavaScript to ease support for importing CommonJS modules */
    esModuleInterop?: boolean;
    /** Ensure each file can be safely transpiled without relying on other imports */
    isolatedModules?: boolean;
    /** Base directory to resolve non-relative module names */
    baseUrl?: string;
    /** Path mapping entries for module resolution */
    paths?: Record<string, string[]>;
    /** List of TypeScript language service plugins to load */
    plugins?: Array<{ name: string;[key: string]: any; }>;

    // Interop Constraints
    /** Ensure that casing is correct in imports */
    forceConsistentCasingInFileNames?: boolean;
    /** Skip type checking of declaration files */
    skipLibCheck?: boolean;
    /** Allow accessing UMD globals from modules */
    allowUmdGlobalAccess?: boolean;

    // Backwards Compatibility
    /** Use the pre-TypeScript 4.1 behavior for keyof */
    keyofStringsOnly?: boolean;
    /** Suppress excess property errors for object literals */
    suppressExcessPropertyErrors?: boolean;
    /** Suppress noImplicitAny errors for indexing objects lacking index signatures */
    suppressImplicitAnyIndexErrors?: boolean;

    // Watch Options
    /** Disable watching file/directory changes */
    watchFile?: string;
    /** Disable watching directory changes */
    watchDirectory?: string;
    /** Disable watching of the fallback poll when using file system events */
    fallbackPolling?: string;
    /** Synchronously call callbacks and update the state of directory watchers */
    synchronousWatchDirectory?: boolean;

    // Compiler Diagnostics
    /** Print names of files part of the compilation */
    listFiles?: boolean;
    /** Print the compiler's version */
    version?: boolean;
    /** Print help message */
    help?: boolean;
    /** Enable verbose logging */
    verbose?: boolean;

    // Projects
    /** Build all projects in the current directory */
    build?: boolean;
    /** Delete outputs of all projects */
    clean?: boolean;
    /** Enable project compilation */
    composite?: boolean;
    /** Generate .tsbuildinfo files to allow for incremental compilation */
    incremental?: boolean;
    /** File to store incremental compilation information */
    tsBuildInfoFile?: string;

    // Output Formatting
    /** Use color and formatting in output */
    pretty?: boolean;
    /** Do not truncate error messages */
    noErrorTruncation?: boolean;

    // Completeness
    /** Report errors if a program tries to include a file twice */
    skipDefaultLibCheck?: boolean;
  };

  /** Files or patterns to include in compilation */
  include?: string[];

  /** Files or patterns to exclude from compilation */
  exclude?: string[];

  /** Specific files to include (overrides include/exclude) */
  files?: string[];

  /** Project references for multi-project builds */
  references?: Array<{ path: string; prepend?: boolean; }>;

  /** Extends another configuration file */
  extends?: string | string[];

  /** Options to pass to the TypeScript compiler API */
  compileOnSave?: boolean;

  /** Type acquisition options for JavaScript projects */
  typeAcquisition?: {
    enable?: boolean;
    include?: string[];
    exclude?: string[];
    disableFilenameBasedTypeAcquisition?: boolean;
  };

  /** Watch options for file watching in --watch mode */
  watchOptions?: {
    watchFile?: "fixedPollingInterval" | "priorityPollingInterval" | "dynamicPriorityPolling" | "useFsEvents" | "useFsEventsOnParentDirectory";
    watchDirectory?: "useFsEvents" | "fixedPollingInterval" | "dynamicPriorityPolling";
    fallbackPolling?: "fixedPollingInterval" | "priorityPollingInterval" | "dynamicPriorityPolling" | "synchronousWatchDirectory";
    synchronousWatchDirectory?: boolean;
    excludeDirectories?: string[];
    excludeFiles?: string[];
  };
};

/**
 * An element in the OrgCache, representing a known host and the last access time.
 */
export type OrgCacheElement = {
  /**
   * a list of known hosts for this org
   */
  host: string;

  /**
   * the last time this entry was accessed
   */
  lastAccess: number;
};

/**
 * The response from the BlueHQ endpoint when calling for any domain.
 */
export type BlueHqAnyUrlResp = {
  orgUrl: string;
};

/**
 * The response from the GQL parents query.
 */
export type GqlParentNameResp = {
  data: {
    parents: {
      id: string;
      displayName: string | null;
    }[];
  };
};