import * as path from 'path';

/**
 * Glob matcher that operates on plain filesystem paths.
 *
 * Supports common glob patterns: `*`, `**`, `?`, `{a,b}`, `[abc]`.
 */
export class GlobMatcher {

  public readonly basePath: string;
  private readonly regexes: RegExp[];

  constructor(basePath: string, patterns: string[]) {
    this.basePath = basePath;
    this.regexes = patterns.map(p => GlobMatcher.globToRegex(p));
  }

  /**
   * Tests whether the given absolute path matches any of the glob patterns
   * relative to the base path.
   */
  public matches(absolutePath: string): boolean {
    const relative = path.relative(this.basePath, absolutePath);
    // Normalize to forward slashes for consistent matching
    const normalized = relative.split(path.sep).join('/');
    return this.regexes.some(re => re.test(normalized));
  }

  /**
   * Convert a glob pattern string into a RegExp.
   *
   * Handles: `**` (any depth), `*` (single segment), `?` (single char),
   * `{a,b}` (alternation), `[abc]` (character class).
   */
  private static globToRegex(pattern: string): RegExp {
    let result = '';
    let i = 0;

    while (i < pattern.length) {
      const ch = pattern[i];

      if (ch === '*') {
        if (pattern[i + 1] === '*') {
          // ** matches any number of path segments
          if (pattern[i + 2] === '/') {
            result += '(?:.+/)?';
            i += 3;
          } else {
            result += '.*';
            i += 2;
          }
        } else {
          // * matches anything except /
          result += '[^/]*';
          i++;
        }
      } else if (ch === '?') {
        result += '[^/]';
        i++;
      } else if (ch === '{') {
        const close = pattern.indexOf('}', i);
        if (close !== -1) {
          const alternatives = pattern.slice(i + 1, close).split(',').map(GlobMatcher.escapeRegex);
          result += `(?:${alternatives.join('|')})`;
          i = close + 1;
        } else {
          result += '\\{';
          i++;
        }
      } else if (ch === '[') {
        const close = pattern.indexOf(']', i);
        if (close !== -1) {
          result += pattern.slice(i, close + 1);
          i = close + 1;
        } else {
          result += '\\[';
          i++;
        }
      } else if ('.+^$|()'.includes(ch)) {
        result += '\\' + ch;
        i++;
      } else {
        result += ch;
        i++;
      }
    }

    return new RegExp(`^${result}$`);
  }

  private static escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
