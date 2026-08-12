import * as path from "path";
import { B6PUri } from "../B6PUri";
import type { FileStat, FileSystem } from "../providers";

/**
 * In-memory mock implementation of {@link FileSystem} for core-level testing.
 * Uses {@link B6PUri} throughout — no VS Code dependencies.
 */
export class MockFileSystem implements FileSystem {
  private files = new Map<string, Uint8Array | Error>();
  private stats = new Map<string, FileStat | Error>();

  /**
   * Map key for a URI: its string form with any trailing folder marker stripped.
   *
   * One directory is one entry regardless of which spelling the caller holds.
   * Keying on the raw `toString()` made `file:///a/b` and `file:///a/b/` distinct,
   * so seeding with `setMockDirectory(uri.asDirectory())` and then asking
   * `exists(uri)` reported false, and a `createDirectory` after a marked `stat`
   * registered the same directory twice. Now that {@link B6PUri.asDirectory} makes
   * the marked spelling normal to hold, that surprise is a real cost in a test
   * double this package ships.
   * @lastreviewed null
   */
  private key(uri: B6PUri): string {
    return B6PUri.stripDirectoryMarker(uri.toString());
  }

  // ── Test helpers ──────────────────────────────────────────────────

  setMockFile(uri: B6PUri, content: string | Uint8Array): void {
    const buffer = typeof content === "string" ? Buffer.from(content) : content;
    this.files.set(this.key(uri), buffer);
    this.stats.set(this.key(uri), {
      type: "file",
      mtime: Date.now(),
      size: buffer.length,
    });
  }

  setMockStat(uri: B6PUri, stat: FileStat): void {
    this.stats.set(this.key(uri), stat);
  }

  setMockDirectory(uri: B6PUri): void {
    this.stats.set(this.key(uri), {
      type: "directory",
      mtime: Date.now(),
      size: 0,
    });
  }

  setMockError(uri: B6PUri, error: Error): void {
    this.files.set(this.key(uri), error);
    this.stats.set(this.key(uri), error);
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
    return this.files.has(this.key(uri));
  }

  getMockFileContent(uri: B6PUri): string | undefined {
    const content = this.files.get(this.key(uri));
    if (content && !(content instanceof Error)) {
      return Buffer.from(content).toString();
    }
    return undefined;
  }

  // ── FileSystem implementation ────────────────────────────────────

  async readFile(uri: B6PUri): Promise<Uint8Array> {
    const content = this.files.get(this.key(uri));
    if (!content) {
      throw new Error(`ENOENT: file not found: ${uri.toString()}`);
    }
    if (content instanceof Error) {
      throw content;
    }
    return content;
  }

  async writeFile(uri: B6PUri, content: Uint8Array): Promise<void> {
    const k = this.key(uri);
    this.files.set(k, content);
    const existing = this.stats.get(k);
    if (existing && !(existing instanceof Error)) {
      this.stats.set(k, { ...existing, mtime: Date.now(), size: content.length });
    } else {
      this.stats.set(k, { type: "file", mtime: Date.now(), size: content.length });
    }
  }

  async stat(uri: B6PUri): Promise<FileStat> {
    const stat = this.stats.get(this.key(uri));
    if (!stat) {
      throw new Error(`ENOENT: no such file or directory: ${uri.toString()}`);
    }
    if (stat instanceof Error) {
      throw stat;
    }
    return stat;
  }

  async readDirectory(uri: B6PUri): Promise<[string, "file" | "directory"][]> {
    const dirStat = this.stats.get(this.key(uri));
    if (!dirStat || dirStat instanceof Error || dirStat.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory: ${uri.toString()}`);
    }

    const entries: [string, "file" | "directory"][] = [];
    const seen = new Set<string>();
    // Keys are marker-free, so the child prefix is the directory key plus one
    // separator. Matching on the bare key would also match a SIBLING whose name
    // extends this one ("/a/b" matching "/a/bc").
    const dirKey = this.key(uri);
    const childPrefix = dirKey + "/";

    for (const [key] of this.files) {
      if (key.startsWith(childPrefix)) {
        const topLevel = key.slice(childPrefix.length).split("/")[0];
        if (topLevel && !seen.has(topLevel)) {
          seen.add(topLevel);
          const childStat = this.stats.get(childPrefix + topLevel);
          entries.push([topLevel, childStat && !(childStat instanceof Error) ? childStat.type : "file"]);
        }
      }
    }

    // Also check stats-only entries (directories without files)
    for (const [key, stat] of this.stats) {
      if (key.startsWith(childPrefix) && !(stat instanceof Error)) {
        const topLevel = key.slice(childPrefix.length).split("/")[0];
        if (topLevel && !seen.has(topLevel)) {
          seen.add(topLevel);
          entries.push([topLevel, stat.type]);
        }
      }
    }

    return entries;
  }

  async delete(uri: B6PUri, options?: { recursive?: boolean }): Promise<void> {
    const key = this.key(uri);
    if (!this.files.has(key) && !this.stats.has(key)) {
      throw new Error(`ENOENT: no such file or directory: ${key}`);
    }

    this.files.delete(key);
    this.stats.delete(key);

    if (options?.recursive) {
      for (const fileKey of [...this.files.keys()]) {
        if (fileKey.startsWith(key + "/")) {
          this.files.delete(fileKey);
          this.stats.delete(fileKey);
        }
      }
      for (const statKey of [...this.stats.keys()]) {
        if (statKey.startsWith(key + "/")) {
          this.stats.delete(statKey);
        }
      }
    }
  }

  async createDirectory(uri: B6PUri): Promise<void> {
    this.setMockDirectory(uri);
  }

  async exists(uri: B6PUri): Promise<boolean> {
    const k = this.key(uri);
    return this.files.has(k) || this.stats.has(k);
  }

  async copy(source: B6PUri, target: B6PUri, options?: { overwrite?: boolean }): Promise<void> {
    const sourceKey = this.key(source);
    const targetKey = this.key(target);
    const sourceContent = this.files.get(sourceKey);
    const sourceStat = this.stats.get(sourceKey);
    if (!sourceContent || !sourceStat) {
      throw new Error(`ENOENT: file not found: ${source.toString()}`);
    }
    if (!options?.overwrite && (this.files.has(targetKey) || this.stats.has(targetKey))) {
      throw new Error(`EEXIST: file already exists: ${target.toString()}`);
    }
    if (!(sourceContent instanceof Error) && !(sourceStat instanceof Error)) {
      this.files.set(targetKey, new Uint8Array(sourceContent));
      this.stats.set(targetKey, { ...sourceStat, mtime: Date.now() });
    }
  }

  async rename(source: B6PUri, target: B6PUri, options?: { overwrite?: boolean }): Promise<void> {
    const sourceKey = this.key(source);
    const targetKey = this.key(target);
    const sourceContent = this.files.get(sourceKey);
    const sourceStat = this.stats.get(sourceKey);
    if (!sourceContent || !sourceStat) {
      throw new Error(`ENOENT: file not found: ${source.toString()}`);
    }
    if (!options?.overwrite && (this.files.has(targetKey) || this.stats.has(targetKey))) {
      throw new Error(`EEXIST: file already exists: ${target.toString()}`);
    }
    if (!(sourceContent instanceof Error) && !(sourceStat instanceof Error)) {
      this.files.set(targetKey, sourceContent);
      this.stats.set(targetKey, sourceStat);
    }
    this.files.delete(sourceKey);
    this.stats.delete(sourceKey);
  }

  async findFiles(base: B6PUri, include: string, _exclude?: string): Promise<B6PUri[]> {
    const results: B6PUri[] = [];
    const basePath = this.key(base);
    const targetFile = include.replace(/^\*\*\//, "");

    for (const [uriStr] of this.files) {
      if (uriStr.startsWith(basePath) && (uriStr.endsWith("/" + targetFile) || uriStr.endsWith(targetFile))) {
        results.push(B6PUri.fromString(uriStr));
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

      if (this.files.has(this.key(targetUri))) {
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
    if (scheme === "file") {
      return true;
    }
    return undefined;
  }
}
