import * as path from "path";
import { Http } from "../constants";
import { MimeTypes } from "../constants/MimeTypes";
import { Err } from "../Err";
import { B6PUri } from "../B6PUri";
import type { ScriptRoot } from "./ScriptRoot";

/**
 * Text file extensions that should have their content included in history snapshots.
 */
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".css",
  ".scss",
  ".html",
  ".htm",
  ".xml",
  ".svg",
  ".txt",
  ".yaml",
  ".yml",
]);

/**
 * Records snapshot history by writing a history entry to the script's object map
 * via a GraphQL mutation. This makes snapshots taken from VS Code appear in the
 * browser IDE's "Project History" view.
 */
export class SnapshotHistoryRecorder {
  /**
   * Record one history entry for the snapshot that was just pushed, via the
   * script type's GraphQL update mutation. Retries on the platform's
   * optimistic-locking "version mismatch" rejection only (see the loop below);
   * every other failure throws on the first attempt.
   * @param scriptRoot The script whose draft tree was just snapshot-pushed
   * @param message The user's snapshot message ("" for none)
   * @param opts.retryDelaysMs Backoff schedule overriding
   *   {@link VERSION_MISMATCH_RETRY_DELAYS_MS} (one retry per entry); used by tests
   * @throws an {@link Err.HttpResponseError} When the mutation ultimately fails
   * @lastreviewed null
   */
  static async record(scriptRoot: ScriptRoot, message: string, opts?: { retryDelaysMs?: number[] }): Promise<void> {
    const ctx = scriptRoot.ctx;
    const scriptKey = await scriptRoot.getScriptKey();
    const mutationName = scriptKey.mutationName;
    const inputType = scriptKey.inputType;

    if (!mutationName || !inputType) {
      ctx.logger.warn(`No GraphQL mutation known for classid ${scriptKey.classid}; skipping history recording.`);
      return;
    }

    const author = this.UNKNOWN_AUTHOR;
    const saveState = await this.buildSaveState(scriptRoot);
    const historyKey = JSON.stringify({
      author,
      timestamp: new Date().toISOString(),
      message: message || undefined,
    });
    const historyValue = JSON.stringify(saveState);
    const draftValue = JSON.stringify({ ...saveState, settings: this.stripContent(saveState.settings) });

    const origin = await scriptRoot.anyOrigin();
    const gqlUrl = new URL("gql", origin);

    const query = `mutation Snapshot($inputs: [${inputType}!]!) { ${mutationName}(inputs: $inputs) { id } }`;
    const variables = {
      inputs: [
        {
          topId: scriptKey.toCompoundId(),
          draft: draftValue,
          addMapObjectEntries: [{ key: historyKey, value: historyValue }],
        },
      ],
    };

    ctx.logger.info(`Recording snapshot history for ${scriptKey.toCompoundId()}`);

    // The upload that just finished bumps the script object's version on the
    // platform, and the bump can still be settling when this mutation lands —
    // the server then rejects it with an optimistic-locking "version mismatch"
    // error even though nothing else touched the script. That state resolves
    // itself in moments, so a mismatch is retried with backoff; every other
    // failure is thrown on the first attempt.
    const retryDelaysMs = opts?.retryDelaysMs ?? SnapshotHistoryRecorder.VERSION_MISMATCH_RETRY_DELAYS_MS;
    const maxAttempts = retryDelaysMs.length + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await ctx.sessionManager.csrfFetch(gqlUrl, {
        method: Http.Methods.POST,
        headers: {
          [Http.Headers.CONTENT_TYPE]: MimeTypes.APPLICATION_JSON,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Err.HttpResponseError(`Failed to record snapshot history: ${response.status} ${text}`);
      }

      const json = (await response.json()) as { errors?: { message: string }[] };
      if (!json.errors?.length) {
        ctx.logger.info("Snapshot history recorded successfully.");
        return;
      }

      const messages = json.errors.map((e) => e.message).join(", ");
      // Matches the observed wording ("Unable to update BaseTable because of
      // version mismatch: expected ver. 5, actual ver. 6") plus the version
      // clause on its own, in case the server ever drops the lead-in.
      const isVersionMismatch = /version mismatch|expected ver\./i.test(messages);
      if (isVersionMismatch && attempt < maxAttempts) {
        const delayMs = retryDelaysMs[attempt - 1];
        ctx.logger.info(
          `Snapshot history hit a version mismatch (the platform is still settling the pushed files); ` +
            `retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      throw new Err.HttpResponseError(`GraphQL errors recording snapshot history: ${messages}`);
    }
  }

  /**
   * Default backoff schedule for retrying the history mutation after a
   * server-side optimistic-locking "version mismatch" rejection (one retry per
   * entry). Tests inject their own schedule via `record()`'s `retryDelaysMs`
   * option rather than mutating shared state.
   * @lastreviewed null
   */
  private static readonly VERSION_MISMATCH_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

  /**
   * The author recorded alongside a snapshot.
   *
   * Under basic auth this was the stored username. Bearer tokens are opaque and
   * carry no client-readable identity, and `author` is embedded in the
   * client-composed `historyKey` blob rather than a schema field the server can
   * backfill — so there is currently no identity to record.
   *
   * //HUMAN-REVIEW-NEEDED restoring a real author requires an identity source:
   * either a `/whoami`-style lookup against the token, or the login response
   * carrying the principal into `SessionData`.
   * @lastreviewed null
   */
  private static readonly UNKNOWN_AUTHOR = "unknown";

  private static async buildSaveState(scriptRoot: ScriptRoot): Promise<SaveState> {
    const ctx = scriptRoot.ctx;
    const draftFolder = scriptRoot.getDraftFolder();
    const allNodes = await draftFolder.flatten();
    const draftRootPath = draftFolder.uri().fsPath;
    const settings: Record<string, FileSetting | FolderSetting> = {};

    for (const node of allNodes) {
      const relativePath = "/" + path.relative(draftRootPath, node.path()).replace(/\\/g, "/");

      if (await node.isInItsRespectiveBuildFolder()) {
        continue;
      }

      if (await node.isFolder()) {
        const folderPath = relativePath.endsWith("/") ? relativePath : relativePath + "/";
        settings[folderPath] = {};
      } else {
        const ext = path.extname(node.path()).toLowerCase();
        if (TEXT_EXTENSIONS.has(ext)) {
          try {
            const bytes = await ctx.fs.readFile(B6PUri.fromFsPath(node.uri().fsPath));
            const content = Buffer.from(bytes).toString("utf-8");
            settings[relativePath] = { content };
          } catch (e) {
            ctx.logger.warn(`Failed to read file for history: ${node.path()}: ${e}`);
          }
        }
      }
    }

    return {
      version: 1,
      isSnapshot: true,
      settings,
    };
  }

  private static stripContent(
    settings: Record<string, FileSetting | FolderSetting>
  ): Record<string, Omit<FileSetting, "content"> | FolderSetting> {
    const stripped: Record<string, object> = {};
    for (const [key, value] of Object.entries(settings)) {
      if ("content" in value) {
        const { content, ...rest } = value;
        stripped[key] = rest;
      } else {
        stripped[key] = value;
      }
    }
    return stripped;
  }
}

interface FileSetting {
  content?: string;
}

interface FolderSetting {
  // empty object for folder entries, matching BSJS convention
}

interface SaveState {
  version: number;
  isSnapshot: boolean;
  settings: Record<string, FileSetting | FolderSetting>;
}
