import { XMLParser } from 'fast-xml-parser';
import type { GqlParentNameResp, XMLResponse } from '../types';
import { ApiEndpoints, FolderNames, Http, MimeTypes, WebDAVElements } from '../constants';
import { Err } from '../Err';
import { ScriptKey } from './ScriptKey';
import type { SessionManager } from '../session/SessionManager';
import type { ILogger, IPrompt } from '../providers';
import { OrgWorker } from './OrgWorker';

type FilePointers = { upstairsPath: string; downstairsPath: string; trailing?: string };
type GetScriptRet = FilePointers[] | null;

/**
 * Parses and interacts with BlueStep WebDAV script URLs.
 *
 * Takes a {@link SessionManager}, `ILogger`, and `IPrompt` via constructor injection.
 */
export class ScriptUrlParser {

  static readonly URL_TYPES = ['files', 'public'] as const;

  url: URL;
  filesOrPublic: typeof ScriptUrlParser.URL_TYPES[number];
  webDavId: string;
  trailing?: string;
  trailingFolder?: string;

  private _scriptName: string | null = null;
  private _orgWorker: OrgWorker | null = null;
  private _scriptKey: ScriptKey | null = null;

  constructor(
    public readonly rawUrlString: string,
    private readonly sessionManager: SessionManager,
    private readonly logger: ILogger,
    private readonly prompt: IPrompt,
  ) {
    if (!rawUrlString || !rawUrlString.trim()) {
      throw new Err.UrlParsingError('URL string cannot be empty');
    }
    const str = rawUrlString.trim();
    try {
      this.url = new URL(str);
    } catch {
      throw new Err.UrlParsingError(`Invalid URL format: ${str}`);
    }

    const pathRegex = /^\/(files|public)\/(\d+)(?:\/(.*))?$/;
    const match = this.url.pathname.match(pathRegex);
    if (!match) {
      throw new Err.UrlParsingError(`URL does not match expected BlueStep format: ${str}`);
    }
    const [, type, webDavId, trailing] = match;

    if (!/^\d+$/.test(webDavId) || webDavId.length > 10) {
      throw new Err.UrlParsingError('the parsed WebDAV ID is probably too large to be legitimate');
    }
    if (!this.isValidType(type)) {
      throw new Err.UrlParsingError(`Invalid path type: ${type}. Expected: ${ScriptUrlParser.URL_TYPES.join(', ')}`);
    }

    this.filesOrPublic = type as typeof ScriptUrlParser.URL_TYPES[number];
    this.webDavId = webDavId;
    this.trailing = trailing;
    this.trailingFolder = trailing?.includes('/') ? trailing.split('/')[0] : undefined;
  }

  private isValidType(type: string): type is typeof ScriptUrlParser.URL_TYPES[number] {
    return ScriptUrlParser.URL_TYPES.includes(type as typeof ScriptUrlParser.URL_TYPES[number]);
  }

  async getU(): Promise<string> {
    return this.orgWorker().getU();
  }

  async getScriptBaseKey(): Promise<ScriptKey> {
    if (this._scriptKey !== null) {return this._scriptKey;}
    await this.getGrandparentInfo();
    if (this._scriptKey === null) {
      throw new Err.ScriptUrlParserError('Failed to fetch script key');
    }
    return this._scriptKey;
  }

  async getScriptName(): Promise<string> {
    if (this._scriptName !== null) {return this._scriptName;}
    await this.getGrandparentInfo();
    if (this._scriptName === null) {
      throw new Err.ScriptUrlParserError('Failed to fetch script name');
    }
    return this._scriptName;
  }

  private async getGrandparentInfo(): Promise<void> {
    if (this._scriptName !== null || this._scriptKey !== null) {
      throw new Err.ScriptUrlParserError('Script name or key already fetched');
    }
    const gqlUrl = this.urlCopy();
    const scriptRootId = '530001___' + this.webDavId;
    const parentQuery = (id: string) =>
      `{"query":"query ObjectData($id: String!) {\\n  parents(childId: $id) {\\n    id\\n    displayName\\n  }\\n}","variables":{"id":"${id}"},"operationName":"ObjectData"}`;

    try {
      gqlUrl.pathname = 'gql';

      const res1 = await this.sessionManager.csrfFetch(gqlUrl, {
        method: Http.Methods.POST,
        headers: { [Http.Headers.CONTENT_TYPE]: MimeTypes.APPLICATION_JSON },
        body: parentQuery(scriptRootId),
      });

      if (!res1.ok) {
        const errorText = await res1.text();
        throw new Err.ScriptUrlParserError(
          `GraphQL query failed for scriptRoot ${scriptRootId}: HTTP ${res1.status} ${res1.statusText}. Response: ${errorText.substring(0, 500)}`
        );
      }

      const responseText1 = await res1.text();
      let json1: GqlParentNameResp;
      try {
        json1 = JSON.parse(responseText1) as GqlParentNameResp;
      } catch {
        throw new Err.ScriptUrlParserError(`Failed to parse GraphQL response for ${scriptRootId}. Response was: ${responseText1.substring(0, 500)}`);
      }

      const parents = json1?.data?.parents;
      if (!parents || parents.length !== 1) {
        throw new Err.ScriptUrlParserError(
          `Expected exactly 1 parent for scriptRoot ${scriptRootId}, got ${parents?.length || 0}. Full response: ${JSON.stringify(json1)}`
        );
      }

      const mediaLibraryId = parents[0].id;
      const res2 = await this.sessionManager.csrfFetch(gqlUrl, {
        method: Http.Methods.POST,
        headers: { [Http.Headers.CONTENT_TYPE]: MimeTypes.APPLICATION_JSON },
        body: parentQuery(mediaLibraryId),
      });

      if (!res2.ok) {
        const errorText = await res2.text();
        throw new Err.ScriptUrlParserError(
          `GraphQL query failed for mediaLibrary ${mediaLibraryId}: HTTP ${res2.status} ${res2.statusText}. Response: ${errorText.substring(0, 500)}`
        );
      }

      const responseText2 = await res2.text();
      let json2: GqlParentNameResp;
      try {
        json2 = JSON.parse(responseText2) as GqlParentNameResp;
      } catch {
        throw new Err.ScriptUrlParserError(
          `Failed to parse GraphQL response for mediaLibrary ${mediaLibraryId}. Response was: ${responseText2.substring(0, 500)}`
        );
      }

      const parents2 = json2?.data?.parents;
      if (!parents2 || parents2.length !== 1) {
        throw new Err.ScriptUrlParserError(
          `Expected exactly 1 parent for mediaLibrary ${mediaLibraryId}, got ${parents2?.length || 0}. Full response: ${JSON.stringify(json2)}`
        );
      }

      const parts = parents2[0].id.split('___');
      if (parts.length !== 2) {
        throw new Err.ScriptUrlParserError(`Script ID has unexpected format. Expected "classid___seqnum", got: ${parents2[0].id}`);
      }

      const displayName = parents2[0].displayName;
      if (!displayName) {
        throw new Err.ScriptUrlParserError(
          `Script displayName is null or empty. Script ID: ${parents2[0].id}.`
        );
      }

      this._scriptName = displayName.replaceAll(/\/|\\/g, '_');
      this._scriptKey = new ScriptKey(parts[0], parts[1]);
    } catch (e) {
      if (e instanceof Err.ScriptUrlParserError) {throw e;}
      throw new Err.ScriptUrlParserError(`Unexpected error fetching script info via GraphQL from ${gqlUrl.href}: ${(e as Error).message}`);
    }
  }

  urlCopy(): URL {
    return new URL(this.url);
  }

  orgWorker(): OrgWorker {
    if (this._orgWorker === null) {
      // Use raw globalThis.fetch for OrgWorker (no auth needed)
      this._orgWorker = new OrgWorker(this.url, globalThis.fetch.bind(globalThis));
    }
    return this._orgWorker;
  }

  async getScript(): Promise<GetScriptRet> {
    const url = this.urlCopy();
    url.pathname = `${ApiEndpoints.FILES}${this.webDavId}/`;
    this.logger.info('Fetching script from URL:', url.href);
    const scriptName = await this.getScriptName();
    return this.getSubScript(url, scriptName);
  }

  async getSubScript(url: URL, scriptName: string, repository: FilePointers[] = []): Promise<FilePointers[] | null> {
    try {
      const response = await this.sessionManager.fetch(url, {
        headers: {
          [Http.Headers.ACCEPT]: Http.Headers.ACCEPT_ALL,
          [Http.Headers.ACCEPT_LANGUAGE]: Http.Headers.ACCEPT_LANGUAGE_EN_US,
          [Http.Headers.CACHE_CONTROL]: Http.Headers.NO_CACHE,
          [Http.Headers.PRAGMA]: Http.Headers.NO_CACHE,
          [Http.Headers.UPGRADE_INSECURE_REQUESTS]: '1',
        },
        method: Http.Methods.PROPFIND,
      });

      if (!response.ok) {
        this.prompt.error(`Failed to fetch sub-script at ${url.href}: ${response.status}. Try again in a moment.`);
        return null;
      }

      const parser = new XMLParser();
      const responseObj: XMLResponse = parser.parse(await response.text());
      const dResponses = responseObj[WebDAVElements.MULTISTATUS][WebDAVElements.RESPONSE];
      if (!dResponses.filter) {
        return repository;
      }

      const firstLayer: FilePointers[] = await Promise.all(
        dResponses
          .map(terminal => {
            // Parse as a URL parser — only need URL fields, not the full session-aware parser
            const href = terminal[WebDAVElements.HREF];
            const parsedUrl = new URL(href, this.url.origin);
            const pathRegex = /^\/(files|public)\/(\d+)(?:\/(.*))?$/;
            const match = parsedUrl.pathname.match(pathRegex);
            return { href: parsedUrl.href, trailing: match?.[3], trailingFolder: match?.[3]?.includes('/') ? match[3].split('/')[0] : undefined };
          })
          .filter(entry => {
            if (entry.trailing === undefined) {return false;}
            if (entry.trailingFolder === FolderNames.SNAPSHOT) {return false;}
            return true;
          })
          .map(async entry => {
            const newPath = `${scriptName}/${entry.trailing}`;
            return { upstairsPath: entry.href, downstairsPath: newPath, trailing: entry.trailing };
          })
      );

      for (const rawFile of firstLayer) {
        if (repository.find(rf => rf.upstairsPath === rawFile.upstairsPath)) {continue;}
        if (rawFile.trailing?.endsWith('/')) {
          const subUrl = new URL(rawFile.upstairsPath);
          if (subUrl.toString() === url.toString()) {
            repository.push(rawFile);
            continue;
          }
          await this.getSubScript(subUrl, scriptName, repository);
        } else {
          repository.push(rawFile);
        }
      }
      return repository;
    } catch (e) {
      this.logger.error('Error getting URL', url.toString());
      throw e;
    }
  }

  toString(): string {
    return JSON.stringify({
      rawUrlString: this.rawUrlString,
      url: this.url.href,
      filesOrPublic: this.filesOrPublic,
      webDavId: this.webDavId,
      trailing: this.trailing,
      trailingFolder: this.trailingFolder,
      scriptName: this._scriptName,
      scriptKey: this._scriptKey,
    }, null, 2);
  }
}
