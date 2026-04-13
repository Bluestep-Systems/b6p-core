import * as path from 'path';
import { Err } from '../Err';
import { FolderNames, SpecialFiles } from '../constants';

/**
 * Core-layer equivalent of `DownstairsUriParser`.
 *
 * Operates on plain filesystem path strings instead of `vscode.Uri`.
 * Parses a path like `/some/path/U123456/scriptName/draft/file.js`
 * into its component parts.
 */
export class DownstairsPathParser {

  public readonly type: "draft" | "declarations" | "metadata" | "root" | "snapshot";
  public readonly U: string;
  public readonly rest: string;
  public readonly prependingPath: string;
  public readonly scriptName: string;

  constructor(readonly rawPath: string) {
    const isAbsolute = path.isAbsolute(rawPath);
    const segments = rawPath.split(path.sep).filter(s => s !== '');

    if (segments.length < 2) {
      throw new Err.InvalidUriStructureError(rawPath);
    }

    const orgIdPattern = /^U\d{6}$/;
    let orgIdIndex = -1;

    for (let i = 0; i < segments.length; i++) {
      if (orgIdPattern.test(segments[i])) {
        orgIdIndex = i;
        break;
      }
    }
    this.U = segments[orgIdIndex];

    if (orgIdIndex === -1) {
      throw new Err.InvalidUriStructureError(
        `Path must contain a segment matching U###### pattern: ${rawPath}`
      );
    }

    if (orgIdIndex + 1 >= segments.length) {
      throw new Err.InvalidUriStructureError(
        `Path must have a scriptName after organization ID: ${rawPath}`
      );
    }

    const scriptNameIndex = orgIdIndex + 1;
    let typeIndex = -1;

    if (scriptNameIndex + 1 < segments.length) {
      const potentialTypeSegment = segments[scriptNameIndex + 1];

      if (potentialTypeSegment === SpecialFiles.GITIGNORE
        || potentialTypeSegment === FolderNames.DRAFT
        || potentialTypeSegment === FolderNames.DECLARATIONS
        || potentialTypeSegment === FolderNames.SNAPSHOT) {
        typeIndex = scriptNameIndex + 1;
      } else {
        throw new Err.InvalidUriStructureError(
          `Invalid type segment: ${potentialTypeSegment} in ${rawPath}`
        );
      }
    }

    const prependingSegments = segments.slice(0, orgIdIndex + 1);
    this.prependingPath = (isAbsolute ? path.sep : '') + prependingSegments.join(path.sep);
    this.scriptName = segments[scriptNameIndex];

    if (typeIndex === -1) {
      this.type = "root";
      this.rest = "";
    } else {
      const typeSegment = segments[typeIndex];
      const restSegments = segments.slice(typeIndex + 1);

      if (typeSegment === SpecialFiles.GITIGNORE) {
        this.type = "metadata";
        this.rest = "";
      } else if (typeSegment === FolderNames.DRAFT || typeSegment === FolderNames.DECLARATIONS || typeSegment === FolderNames.SNAPSHOT) {
        this.type = typeSegment;
        this.rest = restSegments.join(path.sep);
      } else {
        throw new Err.InvalidUriStructureError(rawPath);
      }
    }
  }

  public getShavedName(): string {
    return path.join(this.prependingPath, this.scriptName);
  }

  public equals(other: DownstairsPathParser): boolean {
    return this.prependingPath === other.prependingPath &&
      this.scriptName === other.scriptName &&
      this.type === other.type &&
      this.rest === other.rest;
  }

  public isDeclarationsOrDraft(): boolean {
    return [FolderNames.DRAFT, FolderNames.DECLARATIONS].includes(this.type);
  }

  public isInDefinedFolders(): boolean {
    return [FolderNames.DRAFT, FolderNames.DECLARATIONS, FolderNames.SNAPSHOT].includes(this.type);
  }
}
