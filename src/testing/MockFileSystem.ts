import * as path from 'path';
import { B6PUri } from '../B6PUri';
import type { FileStat, IFileSystem } from '../providers';

/**
 * In-memory mock implementation of {@link IFileSystem} for core-level testing.
 * Uses {@link B6PUri} throughout — no VS Code dependencies.
 */
export class MockFileSystem implements IFileSystem {
  private files = new Map<string, Uint8Array | Error>();
  private stats = new Map<string, FileStat | Error>();

  // ── Test helpers ──────────────────────────────────────────────────

  setMockFile(uri: B6PUri, content: string | Uint8Array): void {
    const buffer = typeof content === 'string' ? Buffer.from(content) : content;
    this.files.set(uri.toString(), buffer);
    this.stats.set(uri.toString(), {
      type: 'file',
      mtime: Date.now(),
      size: buffer.length,
    });
  }

  setMockStat(uri: B6PUri, stat: FileStat): void {
    this.stats.set(uri.toString(), stat);
  }

  setMockDirectory(uri: B6PUri): void {
    this.stats.set(uri.toString(), {
      type: 'directory',
      mtime: Date.now(),
      size: 0,
    });
  }

  setMockError(uri: B6PUri, error: Error): void {
    this.files.set(uri.toString(), error);
    this.stats.set(uri.toString(), error);
  }

  setMockFiles(files: Record<string, string>): void {
    for (const [fsPath, content] of Object.entries(files)) {
      this.setMockFile(B6PUri.fromFsPath(fsPath), content);
    }
  }

  clearMocks(): void {
    this.files.clear();
    this.stats.clear();
  }

  getMockFiles(): string[] {
    return Array.from(this.files.keys());
  }

  hasMockFile(uri: B6PUri): boolean {
    return this.files.has(uri.toString());
  }

  getMockFileContent(uri: B6PUri): string | undefined {
    const content = this.files.get(uri.toString());
    if (content && !(content instanceof Error)) {
      return Buffer.from(content).toString();
    }
    return undefined;
  }

  // ── IFileSystem implementation ────────────────────────────────────

  async readFile(uri: B6PUri): Promise<Uint8Array> {
    const content = this.files.get(uri.toString());
    if (!content) {
      throw new Error(`ENOENT: file not found: ${uri.toString()}`);
    }
    if (content instanceof Error) {
      throw content;
    }
    return content;
  }

  async writeFile(uri: B6PUri, content: Uint8Array): Promise<void> {
    this.files.set(uri.toString(), content);
    const existing = this.stats.get(uri.toString());
    if (existing && !(existing instanceof Error)) {
      this.stats.set(uri.toString(), { ...existing, mtime: Date.now(), size: content.length });
    } else {
      this.stats.set(uri.toString(), { type: 'file', mtime: Date.now(), size: content.length });
    }
  }

  async stat(uri: B6PUri): Promise<FileStat> {
    const stat = this.stats.get(uri.toString());
    if (!stat) {
      throw new Error(`ENOENT: no such file or directory: ${uri.toString()}`);
    }
    if (stat instanceof Error) {
      throw stat;
    }
    return stat;
  }

  async readDirectory(uri: B6PUri): Promise<[string, 'file' | 'directory'][]> {
    const dirStat = this.stats.get(uri.toString());
    if (!dirStat || dirStat instanceof Error || dirStat.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory: ${uri.toString()}`);
    }

    const entries: [string, 'file' | 'directory'][] = [];
    const seen = new Set<string>();
    const dirPath = uri.toString();

    for (const [key] of this.files) {
      if (key.startsWith(dirPath) && key !== dirPath) {
        const relative = key.slice(dirPath.length).replace(/^\//, '');
        const topLevel = relative.split('/')[0];
        if (topLevel && !seen.has(topLevel)) {
          seen.add(topLevel);
          const childStat = this.stats.get(dirPath + (dirPath.endsWith('/') ? '' : '/') + topLevel);
          entries.push([topLevel, childStat && !(childStat instanceof Error) ? childStat.type : 'file']);
        }
      }
    }

    // Also check stats-only entries (directories without files)
    for (const [key, stat] of this.stats) {
      if (key.startsWith(dirPath) && key !== dirPath && !(stat instanceof Error)) {
        const relative = key.slice(dirPath.length).replace(/^\//, '');
        const topLevel = relative.split('/')[0];
        if (topLevel && !seen.has(topLevel)) {
          seen.add(topLevel);
          entries.push([topLevel, stat.type]);
        }
      }
    }

    return entries;
  }

  async delete(uri: B6PUri, options?: { recursive?: boolean }): Promise<void> {
    const key = uri.toString();
    if (!this.files.has(key) && !this.stats.has(key)) {
      throw new Error(`ENOENT: no such file or directory: ${key}`);
    }

    this.files.delete(key);
    this.stats.delete(key);

    if (options?.recursive) {
      for (const fileKey of [...this.files.keys()]) {
        if (fileKey.startsWith(key + '/')) {
          this.files.delete(fileKey);
          this.stats.delete(fileKey);
        }
      }
      for (const statKey of [...this.stats.keys()]) {
        if (statKey.startsWith(key + '/')) {
          this.stats.delete(statKey);
        }
      }
    }
  }

  async createDirectory(uri: B6PUri): Promise<void> {
    this.setMockDirectory(uri);
  }

  async exists(uri: B6PUri): Promise<boolean> {
    return this.files.has(uri.toString()) || this.stats.has(uri.toString());
  }

  async copy(source: B6PUri, target: B6PUri, options?: { overwrite?: boolean }): Promise<void> {
    const sourceContent = this.files.get(source.toString());
    const sourceStat = this.stats.get(source.toString());
    if (!sourceContent || !sourceStat) {
      throw new Error(`ENOENT: file not found: ${source.toString()}`);
    }
    if (!options?.overwrite && (this.files.has(target.toString()) || this.stats.has(target.toString()))) {
      throw new Error(`EEXIST: file already exists: ${target.toString()}`);
    }
    if (!(sourceContent instanceof Error) && !(sourceStat instanceof Error)) {
      this.files.set(target.toString(), new Uint8Array(sourceContent));
      this.stats.set(target.toString(), { ...sourceStat, mtime: Date.now() });
    }
  }

  async rename(source: B6PUri, target: B6PUri, options?: { overwrite?: boolean }): Promise<void> {
    const sourceContent = this.files.get(source.toString());
    const sourceStat = this.stats.get(source.toString());
    if (!sourceContent || !sourceStat) {
      throw new Error(`ENOENT: file not found: ${source.toString()}`);
    }
    if (!options?.overwrite && (this.files.has(target.toString()) || this.stats.has(target.toString()))) {
      throw new Error(`EEXIST: file already exists: ${target.toString()}`);
    }
    if (!(sourceContent instanceof Error) && !(sourceStat instanceof Error)) {
      this.files.set(target.toString(), sourceContent);
      this.stats.set(target.toString(), sourceStat);
    }
    this.files.delete(source.toString());
    this.stats.delete(source.toString());
  }

  async findFiles(base: B6PUri, include: string, _exclude?: string): Promise<B6PUri[]> {
    const results: B6PUri[] = [];
    const basePath = base.toString();
    const targetFile = include.replace(/^\*\*\//, '');

    for (const [uriStr] of this.files) {
      if (uriStr.startsWith(basePath) && (uriStr.endsWith('/' + targetFile) || uriStr.endsWith(targetFile))) {
        results.push(B6PUri.fromUrl(uriStr));
      }
    }
    return results;
  }

  async closest(startUri: B6PUri, fileName: string, maxDepth: number = 10): Promise<B6PUri | null> {
    let currentPath = startUri.fsPath;
    let depth = 0;

    while (depth < maxDepth) {
      const targetPath = path.join(currentPath, fileName);
      const targetUri = B6PUri.fromFsPath(targetPath);

      if (this.files.has(targetUri.toString())) {
        return targetUri;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        break;
      }

      currentPath = parentPath;
      depth++;
    }

    return null;
  }

  isWritableFileSystem(scheme: string): boolean | undefined {
    if (scheme === 'file') {
      return true;
    }
    return undefined;
  }
}
