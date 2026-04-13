import * as path from 'path';
import type { MetaDataDotJsonContent } from '../types';
import { Err } from '../Err';
import { B6PUri } from '../B6PUri';
import type { IFileSystem, IPrompt } from '../providers';

/**
 * Core-layer utility for dealing with IDs in the format `363769__FID_dummyTestEndpoint`.
 *
 * Replaces the vscode-dependent `IdUtility` with provider-based file operations.
 */
export class IdUtility {

  classId: string;
  altIdValue: string;
  altIdKey?: string;

  constructor(id: string) {
    const match = id.match(/^(\d+)__(\w*)_(.+)$/);
    if (match) {
      this.classId = match[1];
      this.altIdKey = match[2];
      this.altIdValue = match[3];
    } else {
      throw new Err.InvalidIdFormatError(id, "something like `363769__FID_dummyTestEndpoint`");
    }
  }

  private toSearchableString(): string {
    return `${this.altIdKey}=${this.altIdValue}`;
  }

  private async isContainedInThisMetadataJsonFile(filePath: string, fs: IFileSystem): Promise<boolean> {
    const uri = B6PUri.fromFsPath(filePath);
    const raw = await fs.readFile(uri);
    const textContent = Buffer.from(raw).toString('utf-8');
    const metadata = JSON.parse(textContent) as MetaDataDotJsonContent;
    if (!metadata.altIds) {
      throw new Err.MetadataFormatError("altIds");
    }
    const existingIds = metadata.altIds.split("\n");
    return existingIds.includes(this.toSearchableString());
  }

  /**
   * Searches a folder recursively for a metadata.json that contains this ID.
   */
  async findFileContaining(folderPath: string, fs: IFileSystem, prompt: IPrompt): Promise<string | null> {
    const folderUri = B6PUri.fromFsPath(folderPath);
    const entries = await fs.readDirectory(folderUri);

    for (const [name, type] of entries) {
      if (type === 'directory') {
        const nestedPath = path.join(folderPath, name);
        try {
          const metadataFiles = await this.findMetadataFiles(nestedPath, fs);
          for (const metadataPath of metadataFiles) {
            const isContained = await this.isContainedInThisMetadataJsonFile(metadataPath, fs);
            if (isContained) {
              return metadataPath;
            }
          }
        } catch (error) {
          prompt.warn(`Error reading directory ${nestedPath}: ${error}`);
        }
      }
    }
    return null;
  }

  /**
   * Recursively find all metadata.json files under a directory.
   */
  private async findMetadataFiles(dirPath: string, fs: IFileSystem): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.readDirectory(B6PUri.fromFsPath(dirPath));

    for (const [name, type] of entries) {
      const full = path.join(dirPath, name);
      if (type === 'directory') {
        const nested = await this.findMetadataFiles(full, fs);
        results.push(...nested);
      } else if (name === 'metadata.json') {
        results.push(full);
      }
    }
    return results;
  }
}
