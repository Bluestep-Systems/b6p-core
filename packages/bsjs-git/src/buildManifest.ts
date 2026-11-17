/**
 * The BSJS build manifest, contract v1: a file under the script's output folder that records the git blob SHA-1 of every
 * source file a build was made from. A git-managed script publishes its `draft` branch exactly as committed, so the
 * server refuses a publish whose sources no longer match the manifest. The platform's build (`ScriptRepo.compileDraft`)
 * writes it in its build commit; nothing here writes one. These are the contract's layout rules, for reading.
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

const SOURCE_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc"]);
const TYPESCRIPT_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts"]);
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
 * Whether the file at `path` is a TypeScript source: a source ({@link isBuildSource}) with the extension `ts`, `tsx`,
 * `mts` or `cts` (any case) whose name is not a declaration (the part before the extension ends in `.d`, as in
 * `globals.d.ts`). A declaration is still a source for the manifest's `sources`, but it emits nothing.
 * @lastreviewed null
 */
export function isTypeScriptSource(path: string, folder: string): boolean {
  if (!isBuildSource(path, folder)) {
    return false;
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = name.slice(dot + 1).toLowerCase();
  return TYPESCRIPT_EXTENSIONS.has(extension) && !name.slice(0, dot).toLowerCase().endsWith(".d");
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
 * The config files that make a tree's build projects, by the platform's rule: every `tsconfig.json` at any depth, plus
 * the root `jsconfig.json` when there is no root `tsconfig.json`. Sorted.
 * @param paths Every file path of the tree (`/`-separated)
 * @lastreviewed null
 */
export function buildConfigPaths(paths: Iterable<string>): string[] {
  const all = [...paths];
  const configs = all.filter((p) => p === "tsconfig.json" || p.endsWith("/tsconfig.json"));
  if (!all.includes("tsconfig.json") && all.includes("jsconfig.json")) {
    configs.push("jsconfig.json");
  }
  return configs.sort();
}

/**
 * The output folders of a tree's build projects, the one resolver the platform, core and the BSJS editor share: for
 * each config ({@link buildConfigPaths}), `<config dir>/` + its {@link buildOutputFolder} (`.build` by default). A
 * project whose folder is empty (output in place) or leaves the tree contributes nothing. Sorted, without repeats.
 * @param configs Each config file's path and text
 * @lastreviewed null
 */
export function buildOutputFolders(configs: Iterable<{ readonly path: string; readonly text: string }>): string[] {
  const folders = new Set<string>();
  for (const config of configs) {
    const folder = buildOutputFolder(config.text);
    if (folder === "") {
      continue;
    }
    const slash = config.path.lastIndexOf("/");
    folders.add(slash < 0 ? folder : `${config.path.slice(0, slash)}/${folder}`);
  }
  return [...folders].sort();
}

/**
 * Rule 3 of the platform's build-commit rule (web `UserCodeScriptHelper`, `bsjs-git-snapshot-design.md`), exactly:
 * every path the commit adds, changes or removes (complete tree entries) must be under the output folder of some build
 * project at the parent ({@link buildOutputFolders}), i.e. start with `<folder>/`; a manifest in a folder is covered.
 * With no folders at all, no commit is a build.
 * @param changedPaths Every path whose tree entry differs between the commit and its parent
 * @param folders The parent's output folders ({@link buildOutputFolders})
 * @lastreviewed null
 */
export function changesOnlyBuildOutput(changedPaths: Iterable<string>, folders: readonly string[]): boolean {
  if (folders.length === 0) {
    return false;
  }
  for (const path of changedPaths) {
    if (!folders.some((folder) => path.startsWith(`${folder}/`))) {
      return false;
    }
  }
  return true;
}
