import * as path from 'path';
import { Http } from '../constants';
import { MimeTypes } from '../constants/MimeTypes';
import { Err } from '../Err';
import { B6PUri } from '../B6PUri';
import type { ScriptRoot } from './ScriptRoot';

/**
 * Text file extensions that should have their content included in history snapshots.
 */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.css', '.scss',
  '.html', '.htm', '.xml', '.svg', '.txt', '.yaml', '.yml',
]);

/**
 * Records snapshot history by writing a history entry to the script's object map
 * via a GraphQL mutation. This makes snapshots taken from VS Code appear in the
 * browser IDE's "Project History" view.
 */
export class SnapshotHistoryRecorder {

  static async record(scriptRoot: ScriptRoot, message: string): Promise<void> {
    const ctx = scriptRoot.ctx;
    const scriptKey = await scriptRoot.getScriptKey();
    const mutationName = scriptKey.mutationName;
    const inputType = scriptKey.inputType;

    if (!mutationName || !inputType) {
      ctx.logger.warn(`No GraphQL mutation known for classid ${scriptKey.classid}; skipping history recording.`);
      return;
    }

    const author = await this.getAuthor(scriptRoot);
    const saveState = await this.buildSaveState(scriptRoot);
    const historyKey = JSON.stringify({
      author,
      timestamp: new Date().toISOString(),
      message: message || undefined,
    });
    const historyValue = JSON.stringify(saveState);
    const draftValue = JSON.stringify({ ...saveState, settings: this.stripContent(saveState.settings) });

    const origin = await scriptRoot.anyOrigin();
    const gqlUrl = new URL('gql', origin);

    const query = `mutation Snapshot($inputs: [${inputType}!]!) { ${mutationName}(inputs: $inputs) { id } }`;
    const variables = {
      inputs: [{
        topId: scriptKey.toCompoundId(),
        draft: draftValue,
        addMapObjectEntries: [{ key: historyKey, value: historyValue }],
      }],
    };

    ctx.logger.info(`Recording snapshot history for ${scriptKey.toCompoundId()}`);

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

    const json = await response.json() as { errors?: { message: string }[] };
    if (json.errors?.length) {
      throw new Err.HttpResponseError(`GraphQL errors recording snapshot history: ${json.errors.map(e => e.message).join(', ')}`);
    }

    ctx.logger.info('Snapshot history recorded successfully.');
  }

  private static async getAuthor(scriptRoot: ScriptRoot): Promise<string> {
    try {
      const auth = await scriptRoot.ctx.auth.getOrCreate();
      return auth.username;
    } catch {
      return 'unknown';
    }
  }

  private static async buildSaveState(scriptRoot: ScriptRoot): Promise<SaveState> {
    const ctx = scriptRoot.ctx;
    const draftFolder = scriptRoot.getDraftFolder();
    const allNodes = await draftFolder.flatten();
    const draftRootPath = draftFolder.uri().fsPath;
    const settings: Record<string, FileSetting | FolderSetting> = {};

    for (const node of allNodes) {
      const relativePath = '/' + path.relative(draftRootPath, node.path()).replace(/\\/g, '/');

      if (await node.isInItsRespectiveBuildFolder()) {
        continue;
      }

      if (await node.isFolder()) {
        const folderPath = relativePath.endsWith('/') ? relativePath : relativePath + '/';
        settings[folderPath] = {};
      } else {
        const ext = path.extname(node.path()).toLowerCase();
        if (TEXT_EXTENSIONS.has(ext)) {
          try {
            const bytes = await ctx.fs.readFile(B6PUri.fromFsPath(node.uri().fsPath));
            const content = Buffer.from(bytes).toString('utf-8');
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

  private static stripContent(settings: Record<string, FileSetting | FolderSetting>): Record<string, Omit<FileSetting, 'content'> | FolderSetting> {
    const stripped: Record<string, object> = {};
    for (const [key, value] of Object.entries(settings)) {
      if ('content' in value) {
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
