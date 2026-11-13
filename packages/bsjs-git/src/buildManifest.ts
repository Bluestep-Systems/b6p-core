/**
 * The BSJS build manifest, contract v1: a file under the script's output folder that records the git blob SHA-1 of every
 * source file a build was made from. A git-managed script publishes its `draft` branch exactly as committed, without
 * recompiling, so the server refuses a publish whose sources no longer match the manifest. Whoever builds writes the
 * manifest in the same commit as the build output.
 *
 * Everything here is pure (no file system, no Node built-ins): paths are as they appear in the git tree, relative to
 * its root, `/`-separated.
 * @lastreviewed null
 */

/**
 * The manifest's file name.
 * @lastreviewed null
 */
export const BUILD_MANIFEST_NAME = ".b6p-build.json";

/**
 * Written to the manifest's informational `builder` field.
 * @lastreviewed null
 */
export const BUILD_MANIFEST_BUILDER = "bsjs-git/0.2.0";

const SOURCE_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc"]);
const DEFAULT_OUT_DIR = ".build";

/**
 * Parses JSON that allows `//` and `/* *\/` comments, trailing commas and a byte order mark, the way a tsconfig is
 * read. Resolves `undefined` when it does not parse.
 * @lastreviewed null
 */
export function parseJsonc(text: string): unknown {
  let source = text.replace(/^﻿/, "");
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += source[++i] ?? "";
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") {
        i++;
      }
      out += "\n";
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 1;
      out += " ";
    } else {
      out += c;
    }
  }
  source = out;
  out = "";
  inString = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += source[++i] ?? "";
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === ",") {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) {
        j++;
      }
      if (source[j] !== "}" && source[j] !== "]") {
        out += c;
      }
    } else {
      out += c;
    }
  }
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

/**
 * The folder `M` the manifest lives in, from the text of the root `tsconfig.json` (or, when there is none, the root
 * `jsconfig.json`): the file's own `compilerOptions.outDir`, `extends` not followed. An absent, non-string or
 * unparsable value means `.build`. The empty string means the tree root (in-place output, or an `outDir` that is empty,
 * only dots and slashes, absolute, has a backslash, or has a `..` segment).
 * @param configText The config file's text, or `undefined` when the tree has neither
 * @lastreviewed null
 */
export function buildOutputFolder(configText: string | undefined): string {
  let declared: string | undefined;
  if (configText !== undefined) {
    const parsed = parseJsonc(configText);
    const options =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { compilerOptions?: unknown }).compilerOptions
        : undefined;
    const outDir =
      typeof options === "object" && options !== null ? (options as { outDir?: unknown }).outDir : undefined;
    if (typeof outDir === "string") {
      declared = outDir;
    }
  }
  let folder = declared === undefined ? DEFAULT_OUT_DIR : declared;
  if (folder.startsWith("./")) {
    folder = folder.slice(2);
  }
  if (
    folder === "" ||
    /^[/.]*$/.test(folder) ||
    folder.startsWith("/") ||
    folder.includes("\\") ||
    folder.split("/").includes("..")
  ) {
    return "";
  }
  return folder.replace(/\/+$/, "");
}

/**
 * The manifest's path in the tree for the output folder `folder` ({@link buildOutputFolder}).
 * @lastreviewed null
 */
export function buildManifestPath(folder: string): string {
  return folder === "" ? BUILD_MANIFEST_NAME : `${folder}/${BUILD_MANIFEST_NAME}`;
}

/**
 * Whether the file at `path` is a source of the build: one of `ts tsx mts cts js jsx mjs cjs json jsonc` by the text
 * after the last `.` of its name (any case; `.d.ts` is `ts`), not the manifest, and not under the output folder.
 * @param folder The output folder ({@link buildOutputFolder}); empty for in-place output, so emitted files beside their
 *        sources are sources too
 * @lastreviewed null
 */
export function isBuildSource(path: string, folder: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0 || !SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) {
    return false;
  }
  if (path === buildManifestPath(folder)) {
    return false;
  }
  return folder === "" || !path.startsWith(`${folder}/`);
}

/**
 * Whether a tree needs no manifest because nothing in it is compiled: no file is named `tsconfig.json`, at any depth.
 * @lastreviewed null
 */
export function hasNoTsconfig(paths: Iterable<string>): boolean {
  for (const path of paths) {
    if (path.slice(path.lastIndexOf("/") + 1) === "tsconfig.json") {
      return false;
    }
  }
  return true;
}

/**
 * The git blob id of some bytes: `sha1("blob <length>\0" + bytes)` as 40 lowercase hex digits, what `git hash-object`
 * prints.
 * @lastreviewed null
 */
export async function gitBlobSha1(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header, 0);
  all.set(bytes, header.length);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", all));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The manifest's text: version 1, keys sorted, two-space indent, a final newline.
 * @param sources Source path to blob id
 * @lastreviewed null
 */
export function formatBuildManifest(
  sources: Readonly<Record<string, string>>,
  builder = BUILD_MANIFEST_BUILDER
): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(sources).sort()) {
    sorted[key] = sources[key];
  }
  return `${JSON.stringify({ builder, sources: sorted, version: 1 }, null, 2)}\n`;
}

/**
 * What {@link planBuildManifest} decided.
 * @lastreviewed null
 */
export interface BuildManifestPlan {
  /** Where the manifest goes. */
  readonly path: string;
  /** Its text. */
  readonly content: string;
}

/**
 * The manifest for the tree a commit will hold, or `undefined` when none is to be written: the script is externally
 * built, or no file in the tree is named `tsconfig.json`.
 *
 * @param tree Every file of the tree as committed: path and git blob id. The manifest itself may be among them (it is
 *        not a source)
 * @param readConfig The bytes of a root file by path (`tsconfig.json`, `jsconfig.json`), `undefined` when absent
 * @param options.externallyBuilt A bundler builds this script, so its inputs are unknowable here: no manifest
 * @lastreviewed null
 */
export async function planBuildManifest(
  tree: readonly { readonly path: string; readonly oid: string }[],
  readConfig: (path: string) => Promise<Uint8Array | undefined>,
  options: { readonly externallyBuilt?: boolean } = {}
): Promise<BuildManifestPlan | undefined> {
  if (options.externallyBuilt || hasNoTsconfig(tree.map((f) => f.path))) {
    return undefined;
  }
  const config = (await readConfig("tsconfig.json")) ?? (await readConfig("jsconfig.json"));
  const folder = buildOutputFolder(config === undefined ? undefined : new TextDecoder().decode(config));
  const sources: Record<string, string> = {};
  for (const file of tree) {
    if (isBuildSource(file.path, folder)) {
      sources[file.path] = file.oid;
    }
  }
  return { path: buildManifestPath(folder), content: formatBuildManifest(sources) };
}
