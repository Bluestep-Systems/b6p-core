/**
 * One variable of a git config file, as git 2.53's parser (config.c `git_parse_source`,
 * `get_base_var`, `get_extended_base_var`, `get_value`, `parse_value`) reads it, with where its text
 * sits in the file.
 * @lastreviewed null
 */
export interface ConfigFileEntry {
  /**
   * The key as `git config` prints it: section (and a `[section.sub]` subsection) lowercase, a
   * quoted subsection as written, name lowercase.
   * @lastreviewed null
   */
  readonly key: string;
  /**
   * The value, `null` for a key with no `=`.
   * @lastreviewed null
   */
  readonly value: string | null;
  /**
   * Where its line starts and where its last line (continuations included) ends, after the newline.
   * @lastreviewed null
   */
  readonly lineStart: number;
  readonly lineEnd: number;
  /**
   * Whether nothing but whitespace precedes it on its first line (no section header before it).
   * @lastreviewed null
   */
  readonly ownLine: boolean;
  /**
   * The section header it is under: its line's start and end, or `-1` before any header.
   * @lastreviewed null
   */
  readonly headerStart: number;
  readonly headerEnd: number;
}

const isKeyChar = (c: string): boolean => /^[A-Za-z0-9-]$/.test(c);
// git's own isspace (ctype.c): space, tab, LF and CR only.
const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * Parse a git config file's text. `null` where git would reject it (a bad header, an unknown escape,
 * an unterminated quote), so nothing is edited in a file git itself cannot read. The text is the
 * file's bytes, one latin1 character each, as `editConfigFile` reads it (a JavaScript string of the
 * same ASCII content parses the same way).
 * @lastreviewed null
 */
export function parseConfigFile(text: string): ConfigFileEntry[] | null {
  let pos = text.startsWith("\xEF\xBB\xBF") ? 3 : text.startsWith("\uFEFF") ? 1 : 0;
  // get_next_char: CRLF reads as LF, the end of the text as a final LF.
  const next = (): string => {
    if (pos >= text.length) {
      pos = text.length + 1;
      return "\n";
    }
    let c = text[pos++];
    if (c === "\r" && text[pos] === "\n") {
      c = text[pos++];
    }
    return c;
  };
  const eof = (): boolean => pos > text.length;
  const lineStartOf = (at: number): number => text.lastIndexOf("\n", at - 1) + 1;
  const entries: ConfigFileEntry[] = [];
  let stem = "";
  let headerStart = -1;
  let headerEnd = -1;
  let comment = false;
  for (;;) {
    const at = pos;
    const c = next();
    if (c === "\n") {
      if (eof()) {
        return entries;
      }
      comment = false;
      continue;
    }
    if (comment || isSpace(c)) {
      continue;
    }
    if (c === "#" || c === ";") {
      comment = true;
      continue;
    }
    if (c === "[") {
      headerStart = lineStartOf(at);
      let name = "";
      for (;;) {
        const h = next();
        if (eof()) {
          return null;
        }
        if (h === "]") {
          break;
        }
        if (isSpace(h)) {
          if (h === "\n") {
            return null;
          }
          let q = next();
          while (isSpace(q)) {
            if (q === "\n") {
              return null;
            }
            q = next();
          }
          if (q !== '"') {
            return null;
          }
          name += ".";
          for (;;) {
            let s = next();
            if (s === "\n") {
              return null;
            }
            if (s === '"') {
              break;
            }
            if (s === "\\") {
              s = next();
              if (s === "\n") {
                return null;
              }
            }
            name += s;
          }
          if (next() !== "]") {
            return null;
          }
          break;
        }
        if (!isKeyChar(h) && h !== ".") {
          return null;
        }
        name += h.toLowerCase();
      }
      if (name === "") {
        return null;
      }
      stem = `${name}.`;
      const close = text.indexOf("\n", pos - 1);
      headerEnd = close === -1 ? text.length : close + 1;
      continue;
    }
    if (!/^[A-Za-z]$/.test(c)) {
      return null;
    }
    const lineStart = lineStartOf(at);
    const ownLine = text.slice(lineStart, at).trim() === "" && lineStart >= headerEnd;
    let name = c.toLowerCase();
    let k = next();
    while (!eof() && isKeyChar(k)) {
      name += k.toLowerCase();
      k = next();
    }
    while (k === " " || k === "\t") {
      k = next();
    }
    let value: string | null = null;
    if (k !== "\n") {
      if (k !== "=") {
        return null;
      }
      value = parseValue(next);
      if (value === null) {
        return null;
      }
    }
    entries.push({
      key: stem + name,
      value,
      lineStart,
      lineEnd: Math.min(pos, text.length),
      ownLine,
      headerStart,
      headerEnd,
    });
  }
}

// parse_value: quotes, the escapes git knows, `;`/`#` comments outside quotes, trailing blanks dropped.
function parseValue(next: () => string): string | null {
  let quote = false;
  let comment = false;
  let value = "";
  let trimLen = 0;
  for (;;) {
    let c = next();
    if (c === "\n") {
      if (quote) {
        return null;
      }
      return trimLen ? value.slice(0, trimLen) : value;
    }
    if (comment) {
      continue;
    }
    if (isSpace(c) && !quote) {
      if (!trimLen) {
        trimLen = value.length;
      }
      if (value.length) {
        value += c;
      }
      continue;
    }
    if (!quote && (c === ";" || c === "#")) {
      comment = true;
      continue;
    }
    trimLen = 0;
    if (c === "\\") {
      c = next();
      if (c === "\n") {
        continue;
      }
      const escaped: Record<string, string> = { t: "\t", b: "\b", n: "\n", "\\": "\\", '"': '"' };
      if (!(c in escaped)) {
        return null;
      }
      value += escaped[c];
      continue;
    }
    if (c === '"') {
      quote = !quote;
      continue;
    }
    value += c;
  }
}

/**
 * The places in a parsed file where `helper` directly follows an empty value among `key`'s
 * values (the pair setup writes), counted as git sees them, wherever they sit on their lines (a
 * reset on its section's header line included): each as the two entries.
 * @lastreviewed null
 */
export function pairsIn(
  entries: readonly ConfigFileEntry[],
  key: string,
  helper: string
): [ConfigFileEntry, ConfigFileEntry][] {
  const values = entries.filter((e) => e.key === key);
  const pairs: [ConfigFileEntry, ConfigFileEntry][] = [];
  for (let i = 0; i + 1 < values.length; i++) {
    const [reset, after] = [values[i], values[i + 1]];
    if (reset.value === "" && after.value === helper) {
      pairs.push([reset, after]);
      i++;
    }
  }
  return pairs;
}

function quoteValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t")}"`;
}

/**
 * `text` with a new `[credential "<url>"]` section appended, holding a reset and then `helper`.
 * The file is first made to end cleanly: a last line without a newline gets one, and a last line
 * ending in an unescaped `\` (a value continued onto the next line) is followed by an empty line,
 * which ends the continued value with nothing added, so git reads every existing value as before.
 * @lastreviewed null
 */
export function appendPair(text: string, url: string, helper: string): string {
  const body = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
  const continued = (/\\+$/.exec(body)?.[0].length ?? 0) % 2 === 1;
  let head = text === "" || body !== text ? text : `${text}\n`;
  if (continued) {
    head += "\n";
  }
  const sub = url.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${head}[credential "${sub}"]\n\thelper =\n\thelper = ${quoteValue(helper)}\n`;
}

/**
 * `text` without the two lines of `pair`, and without their section header too when nothing but
 * whitespace is left under it.
 * @lastreviewed null
 */
export function removePair(
  text: string,
  entries: readonly ConfigFileEntry[],
  pair: [ConfigFileEntry, ConfigFileEntry]
): string {
  const [reset, helper] = pair;
  const cut = [
    [helper.lineStart, helper.lineEnd],
    [reset.lineStart, reset.lineEnd],
  ];
  const header = reset.headerStart;
  if (header !== -1 && header === helper.headerStart) {
    const others = entries.filter((e) => e.headerStart === header && e !== reset && e !== helper);
    const sectionEnd = nextHeaderAfter(text, entries, reset.headerEnd);
    const rest =
      text.slice(reset.headerEnd, reset.lineStart) +
      text.slice(reset.lineEnd, helper.lineStart) +
      text.slice(helper.lineEnd, sectionEnd);
    const headerLine = text.slice(header, reset.headerEnd);
    if (others.length === 0 && rest.trim() === "" && /^\s*\[[^\]]*\]\s*$/.test(headerLine)) {
      cut.splice(0, 2, [header, sectionEnd]);
    }
  }
  let out = text;
  for (const [start, end] of cut.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

function nextHeaderAfter(text: string, entries: readonly ConfigFileEntry[], from: number): number {
  const starts = entries.map((e) => e.headerStart).filter((h) => h >= from);
  let end = starts.length ? Math.min(...starts) : text.length;
  // A later header with no variables under it is not in `entries`: look for a `[` starting a line.
  const re = /^[ \t]*\[/gm;
  re.lastIndex = from;
  const m = re.exec(text);
  if (m && m.index < end) {
    end = m.index;
  }
  return end;
}

/**
 * Whether `after` holds every entry of `before`, keys and values as git reads them, in order, and
 * then exactly `added` more.
 * @lastreviewed null
 */
export function keepsEntries(
  before: readonly ConfigFileEntry[],
  after: readonly ConfigFileEntry[],
  added: number
): boolean {
  return (
    after.length === before.length + added &&
    before.every((entry, i) => entry.key === after[i].key && entry.value === after[i].value)
  );
}
