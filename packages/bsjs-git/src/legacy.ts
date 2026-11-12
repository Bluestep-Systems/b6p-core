import {
  BadSaveStateError,
  GitAuthError,
  GitPermissionError,
  GitRepoNotFoundError,
  LegacyHistoryError,
} from "./errors";
import type { FetchLike } from "./http";

/**
 * One entry of the legacy history archive, as the list endpoint returns it (newest first).
 * @lastreviewed null
 */
export interface LegacyHistoryEntry {
  /**
   * Opaque: pass it back to {@link LegacyHistoryClient.get} and, as `before`, to {@link LegacyHistoryClient.list}.
   * @lastreviewed null
   */
  readonly id: string;
  readonly author: string;
  /**
   * ISO 8601.
   * @lastreviewed null
   */
  readonly timestamp: string;
  readonly message?: string;
}

/**
 * One file or folder of a stored saveState.
 * @lastreviewed null
 */
export interface HistoryTreeEntry {
  /**
   * Path with a leading slash; a folder's ends with a slash.
   * @lastreviewed null
   */
  readonly path: string;
  readonly kind: "file" | "folder";
  /**
   * The file's text; absent for a folder and for a file stored without content (non-text).
   * @lastreviewed null
   */
  readonly content?: string;
  /**
   * The editor's `external` flag, where the saveState carried one.
   * @lastreviewed null
   */
  readonly external?: boolean;
}

/**
 * A stored saveState, parsed into one shape whichever format it was saved in.
 * @lastreviewed null
 */
export interface HistoryTree {
  /**
   * The saveState format that was parsed: 1 is `{version:1,settings}`, 0 is the older nested tree.
   * @lastreviewed null
   */
  readonly version: 0 | 1;
  readonly entries: readonly HistoryTreeEntry[];
}

/**
 * Paging for {@link LegacyHistoryClient.list}.
 * @lastreviewed null
 */
export interface LegacyListOptions {
  /**
   * At most this many entries. Default: the server's.
   * @lastreviewed null
   */
  readonly limit?: number;
  /**
   * An entry id to continue after (exclusive): the last id of the previous page.
   * @lastreviewed null
   */
  readonly before?: string;
}

type Json = unknown;

function isObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a stored saveState (the text the legacy archive holds) into a {@link HistoryTree}.
 *
 * Version 1 is `{version:1, settings:{"/path":{content?,external?}, "/folder/":{}}}`: a key ending in a slash is a
 * folder, an entry without `content` is a file stored without it. Version 0 is the older nested tree,
 * `{name:{files:{...}} | {name, extension?, content}}`, whose `.mjs` entries are skipped (they moved to `/.build`
 * when the editor moved to WebDAV).
 *
 * @throws {BadSaveStateError} when the text is neither.
 * @lastreviewed null
 */
export function parseSaveState(text: string | Json): HistoryTree {
  let root: Json;
  try {
    root = typeof text === "string" ? JSON.parse(text) : text;
  } catch (cause) {
    throw new BadSaveStateError(`saveState is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!isObject(root)) {
    throw new BadSaveStateError("saveState is not an object");
  }
  const entries: HistoryTreeEntry[] = [];
  if ("version" in root) {
    if (root.version !== 1 || !isObject(root.settings)) {
      throw new BadSaveStateError(`Unsupported saveState version ${String(root.version)}`);
    }
    for (const [path, setting] of Object.entries(root.settings)) {
      if (!isObject(setting)) {
        throw new BadSaveStateError(`saveState setting for ${path} is not an object`);
      }
      if (path.endsWith("/")) {
        entries.push({ path, kind: "folder" });
        continue;
      }
      entries.push({
        path,
        kind: "file",
        ...(typeof setting.content === "string" ? { content: setting.content } : {}),
        ...(typeof setting.external === "boolean" ? { external: setting.external } : {}),
      });
    }
    return { version: 1, entries };
  }
  collectVersion0("/", root, entries);
  return { version: 0, entries };
}

function collectVersion0(parent: string, node: Record<string, Json>, entries: HistoryTreeEntry[]): void {
  for (const [name, item] of Object.entries(node)) {
    if (!isObject(item)) {
      continue;
    }
    if (isObject(item.files)) {
      const path = `${parent}${name}/`;
      entries.push({ path, kind: "folder" });
      collectVersion0(path, item.files, entries);
    } else if ("name" in item && !name.endsWith(".mjs")) {
      const fileName = item.extension ? `${String(item.name)}.${String(item.extension)}` : String(item.name);
      entries.push({
        path: `${parent}${fileName}`,
        kind: "file",
        ...(typeof item.content === "string" ? { content: item.content } : {}),
      });
    }
  }
}

/**
 * The text files of a tree as path to content (folders and content-less files left out).
 * @lastreviewed null
 */
export function treeFiles(tree: HistoryTree): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of tree.entries) {
    if (entry.kind === "file" && entry.content !== undefined) {
      files.set(entry.path, entry.content);
    }
  }
  return files;
}

/**
 * What {@link LegacyHistoryClient} needs.
 * @lastreviewed null
 */
export interface LegacyHistoryClientOptions {
  /**
   * The organization's base URL, such as `https://org.bluestep.net/`.
   * @lastreviewed null
   */
  readonly baseUrl: string | URL;
  /**
   * The b6pt_ bearer token.
   * @lastreviewed null
   */
  readonly token: string;
  readonly fetch?: FetchLike;
}

/**
 * Read-only client for the legacy script-history archive: the saves recorded before scripts moved to git, kept
 * on the platform and served by `GET /api/v1/legacy-script-history/{scriptId}` (a paged list, newest first) and
 * `GET /api/v1/legacy-script-history/{scriptId}/{entryId}` (one stored saveState). Needs view permission on the script.
 * @lastreviewed null
 */
export class LegacyHistoryClient {
  readonly #origin: string;
  readonly #token: string;
  readonly #fetch: FetchLike;

  constructor(options: LegacyHistoryClientOptions) {
    this.#origin = `${new URL(String(options.baseUrl)).origin}/`;
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * One page of entries, newest first.
   * @param scriptId the script's compound id, `classid___seqnum`.
   * @lastreviewed null
   */
  async list(scriptId: string, options: LegacyListOptions = {}): Promise<LegacyHistoryEntry[]> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) {
      query.set("limit", String(options.limit));
    }
    if (options.before !== undefined) {
      query.set("before", options.before);
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const body = await this.#getJson(`${this.#path(scriptId)}${suffix}`);
    if (!Array.isArray(body)) {
      throw new LegacyHistoryError("The legacy history list was not an array");
    }
    return body.map((item): LegacyHistoryEntry => {
      if (!isObject(item) || typeof item.id !== "string" || typeof item.timestamp !== "string") {
        throw new LegacyHistoryError("A legacy history entry lacked an id or a timestamp");
      }
      return {
        id: item.id,
        author: typeof item.author === "string" ? item.author : "",
        timestamp: item.timestamp,
        ...(typeof item.message === "string" ? { message: item.message } : {}),
      };
    });
  }

  /**
   * One entry's stored tree, parsed.
   * @param entryId an {@link LegacyHistoryEntry.id}.
   * @lastreviewed null
   */
  async get(scriptId: string, entryId: string): Promise<HistoryTree> {
    return parseSaveState(await this.#getJson(`${this.#path(scriptId)}/${encodeURIComponent(entryId)}`));
  }

  #path(scriptId: string): string {
    return `${this.#origin}api/v1/legacy-script-history/${encodeURIComponent(scriptId)}`;
  }

  async #getJson(url: string): Promise<Json> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { Authorization: `Bearer ${this.#token}`, Accept: "application/json" },
      });
    } catch (cause) {
      throw new LegacyHistoryError(`Could not reach the platform: ${cause instanceof Error ? cause.message : cause}`);
    }
    if (response.status === 401) {
      throw new GitAuthError();
    }
    if (response.status === 403) {
      throw new GitPermissionError("");
    }
    if (response.status === 404) {
      throw new GitRepoNotFoundError();
    }
    if (!response.ok) {
      throw new LegacyHistoryError(`The legacy history endpoint answered HTTP ${response.status}`, response.status);
    }
    return response.json() as Promise<Json>;
  }
}
