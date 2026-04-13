import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

/**
 * Cross-platform URI abstraction that replaces `vscode.Uri` in the core layer.
 *
 * Internally stores a canonical `file://` URL string (for filesystem paths) or
 * an arbitrary URL string (for WebDAV / HTTP targets). Uses Node's `url` module
 * for the platform-specific heavy lifting — `pathToFileURL` and `fileURLToPath`
 * handle Windows drive-letter normalization, backslash conversion, etc.
 */
export class B6PUri {

  private constructor(
    private readonly _href: string
  ) {}

  // ── Constructors ──────────────────────────────────────────────────

  /** Create from a platform-native filesystem path (e.g. `C:\Users\foo` or `/home/foo`). */
  static fromFsPath(fsPath: string): B6PUri {
    return new B6PUri(pathToFileURL(fsPath).href);
  }

  /** Create from any URL string (`file://`, `https://`, etc.). */
  static fromUrl(url: string): B6PUri {
    return new B6PUri(url);
  }

  // ── Accessors ─────────────────────────────────────────────────────

  /** Platform-correct filesystem path. Only valid for `file://` URIs. */
  get fsPath(): string {
    return fileURLToPath(this._href);
  }

  /** The full URL string. */
  toString(): string {
    return this._href;
  }

  /** The scheme portion (`file`, `https`, etc.). */
  get scheme(): string {
    return new URL(this._href).protocol.replace(/:$/, '');
  }

  /** Whether this is a `file://` URI. */
  get isFile(): boolean {
    return this.scheme === 'file';
  }

  // ── Path operations ───────────────────────────────────────────────

  /** Join path segments onto this URI, using posix rules on the URL pathname. */
  joinPath(...segments: string[]): B6PUri {
    if (this.isFile) {
      return B6PUri.fromFsPath(path.join(this.fsPath, ...segments));
    }
    const url = new URL(this._href);
    url.pathname = path.posix.join(url.pathname, ...segments);
    return new B6PUri(url.href);
  }

  /** The final path component (file or folder name). */
  get basename(): string {
    if (this.isFile) {
      return path.basename(this.fsPath);
    }
    return path.posix.basename(new URL(this._href).pathname);
  }

  /** A new URI pointing to the parent directory. */
  get dirname(): B6PUri {
    if (this.isFile) {
      return B6PUri.fromFsPath(path.dirname(this.fsPath));
    }
    const url = new URL(this._href);
    url.pathname = path.posix.dirname(url.pathname);
    return new B6PUri(url.href);
  }

  // ── Comparison ────────────────────────────────────────────────────

  equals(other: B6PUri): boolean {
    return this._href === other._href;
  }
}
