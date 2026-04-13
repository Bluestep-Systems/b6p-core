import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { FolderNames, Http, SpecialFiles } from './constants';
import { B6PUri } from './B6PUri';
import { GlobMatcher } from './data/GlobMatcher';
import { ScriptUrlParser } from './data/ScriptUrlParser';
import { ScriptFactory } from './script/ScriptFactory';
import type { ScriptContext } from './script/ScriptContext';
import type { IFileSystem, IProgress, ProgressTask } from './providers';
import { Err } from './Err';
import type { ScriptFile } from './script/ScriptFile';

/**
 * Recursively collect all files under a directory.
 */
async function flattenDirectory(dirPath: string, fs: IFileSystem): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readDirectory(B6PUri.fromFsPath(dirPath));
  for (const [name, type] of entries) {
    const full = path.join(dirPath, name);
    if (type === 'directory') {
      const nested = await flattenDirectory(full, fs);
      results.push(...nested);
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Read .gitignore patterns from the script root. Used only for the cleanup
 * pass; per-file gitignore filtering during upload is handled inside
 * ScriptFile.upload() / getReasonToNotPush().
 */
async function readGitIgnorePatterns(rootPath: string, fs: IFileSystem): Promise<string[]> {
  const gitignorePath = path.join(rootPath, SpecialFiles.GITIGNORE);
  const uri = B6PUri.fromFsPath(gitignorePath);
  try {
    const raw = await fs.readFile(uri);
    const text = Buffer.from(raw).toString('utf-8');
    return text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
  } catch {
    return ['**/.DS_Store'];
  }
}

/**
 * Core push implementation.
 *
 * Delegates the per-file work to {@link ScriptFile.upload}, which handles:
 *  - exclusion logic (declarations / .git / .gitignore / integrity match)
 *  - collision detection against last-verified hash with user prompt
 *  - snapshot dual-write (draft + snapshot)
 *  - metadata `lastVerifiedHash` updates via touch()
 *  - rich error wrapping
 */
export async function executePush(opts: {
  ctx: ScriptContext;
  progress: IProgress;
  targetUrl: string;
  rootPath: string;
  snapshot: boolean;
}): Promise<void> {
  const { ctx, progress, targetUrl, rootPath, snapshot } = opts;
  const { fs, prompt, logger, sessionManager } = ctx;
  const draftPath = path.join(rootPath, FolderNames.DRAFT);

  const draftUri = B6PUri.fromFsPath(draftPath);
  if (!(await fs.exists(draftUri))) {
    prompt.error(`Draft folder not found: ${draftPath}`);
    return;
  }

  // Build a parser from the target URL so the ScriptRoot can resolve
  // upstairs URLs (mirrors what executePull does on the pull side).
  const parser = new ScriptUrlParser(targetUrl, sessionManager, logger, prompt);
  const factory = new ScriptFactory(ctx);

  // One ScriptRoot for the whole push; all files in this draft tree are
  // siblings under the same root.
  const rootUri = B6PUri.fromFsPath(path.join(rootPath, '/'));
  const scriptRoot = factory.createScriptRoot(rootUri);
  scriptRoot.withParser(parser);

  const allFiles = await flattenDirectory(draftPath, fs);
  logger.info(`Found ${allFiles.length} files in draft folder`);

  if (allFiles.length === 0) {
    prompt.info('No files to push — draft folder is empty.');
    return;
  }

  const uploadTasks: ProgressTask<void>[] = allFiles.map(filePath => ({
    execute: async () => {
      const fileUri = B6PUri.fromFsPath(filePath);
      const file = factory.createFile(fileUri, scriptRoot);
      try {
        await file.upload({ isSnapshot: snapshot });
      } catch (e) {
        if (e instanceof Err.UserCancelledError) {
          // Surface cancellation to the progress runner so it can stop the batch.
          throw e;
        }
        logger.error(`Failed to push ${filePath}: ${e instanceof Error ? e.message : e}`);
        throw e;
      }
    },
    description: path.basename(filePath),
  }));

  await progress.withProgress(uploadTasks, {
    title: snapshot ? 'Pushing Snapshot...' : 'Pushing Script...',
    showItemCount: true,
    cleanupMessage: 'Cleaning up...',
  });

  // Cleanup: delete unused upstairs paths.
  const gitignorePatterns = await readGitIgnorePatterns(rootPath, fs);
  const gitignoreMatcher = new GlobMatcher(rootPath, gitignorePatterns);
  await cleanupUnusedUpstairsPaths({
    ctx,
    targetUrl,
    draftPath,
    gitignoreMatcher,
  });

  prompt.info(snapshot ? 'Snapshot complete!' : 'Push complete!');
}

/**
 * Delete remote files that no longer have a local counterpart.
 */
async function cleanupUnusedUpstairsPaths(opts: {
  ctx: ScriptContext;
  targetUrl: string;
  draftPath: string;
  gitignoreMatcher: GlobMatcher;
}): Promise<void> {
  const { ctx, targetUrl, draftPath, gitignoreMatcher } = opts;
  const { fs, prompt, logger, sessionManager } = ctx;

  try {
    const parser = new XMLParser();

    const response = await sessionManager.fetch(targetUrl, {
      headers: {
        [Http.Headers.ACCEPT]: Http.Headers.ACCEPT_ALL,
        [Http.Headers.CACHE_CONTROL]: Http.Headers.NO_CACHE,
      },
      method: Http.Methods.PROPFIND,
    });

    if (!response.ok) {
      logger.warn(`PROPFIND failed during cleanup: ${response.status}`);
      return;
    }

    const xml = await response.text();
    const parsed = parser.parse(xml);
    const responses = parsed?.['D:multistatus']?.['D:response'];
    if (!responses?.filter) {
      return;
    }

    const localFiles = await flattenDirectory(draftPath, fs);
    const localRelatives = new Set(
      localFiles.map(f => path.relative(draftPath, f).split(path.sep).join('/'))
    );

    const pathsToDelete: string[] = [];

    for (const entry of responses) {
      const href = entry['D:href'];
      if (!href) {continue;}

      const entryUrl = new URL(href, targetUrl);
      const basePath = new URL(targetUrl).pathname;
      const relative = entryUrl.pathname.slice(basePath.length);

      if (!relative || relative === '/') {continue;}

      const draftPrefix = FolderNames.DRAFT + '/';
      if (!relative.startsWith(draftPrefix)) {continue;}

      const draftRelative = relative.slice(draftPrefix.length);
      if (!draftRelative) {continue;}

      if (draftRelative.endsWith('/')) {continue;}

      const localEquivalent = path.join(draftPath, ...draftRelative.split('/'));
      if (gitignoreMatcher.matches(localEquivalent)) {
        logger.info(`File is in .gitignore; skipping deletion: ${href}`);
        continue;
      }

      if (!localRelatives.has(draftRelative)) {
        pathsToDelete.push(entryUrl.href);
      }
    }

    if (pathsToDelete.length === 0) {
      logger.info('No unused upstairs paths to delete.');
      return;
    }

    const YES = 'Yes';
    const NO = 'No';
    const answer = await prompt.confirm(
      `The following ${pathsToDelete.length} upstairs path(s) no longer have local counterparts:\n\n${pathsToDelete.join('\n')}\n\nDelete them?`,
      [YES, NO]
    );

    if (answer !== YES) {
      prompt.info('User chose not to delete unused upstairs paths.');
      return;
    }

    for (const url of pathsToDelete) {
      logger.info('Deleting unused upstairs path: ' + url);
      await sessionManager.fetch(url, { method: Http.Methods.DELETE });
    }
  } catch (e) {
    logger.warn(`Cleanup failed: ${e instanceof Error ? e.message : e}`);
  }
}
