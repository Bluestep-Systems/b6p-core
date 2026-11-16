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
 * One build project of a tree: the folder its `tsconfig.json` (or `jsconfig.json`) sits in (`""` at the root) and
 * that file's text.
 * @lastreviewed null
 */
export interface BuildProjectConfig {
  readonly dir: string;
  readonly text: string;
}

const EMITTED_IN_PLACE = /\.(?:[cm]?js|[cm]?js\.map|d\.[cm]?ts|d\.[cm]?ts\.map)$/i;

/**
 * Whether a path is something a build writes, never an author's source: under a project's output folder
 * ({@link buildOutputFolder}, relative to the project's folder), the manifest, or, for a project with in-place output,
 * an emitted file (`.js`, `.mjs`, `.cjs`, a declaration, or a map of one) under the project's folder. Used to tell the
 * platform's build commit from an edit: a commit that changes any other path is not a build.
 * @param path A tree path (`/`-separated)
 * @param projects Every build project of the tree the build ran on
 * @lastreviewed null
 */
export function isBuildOutputPath(path: string, projects: readonly BuildProjectConfig[]): boolean {
  for (const project of projects) {
    const base = project.dir === "" ? "" : `${project.dir}/`;
    if (base !== "" && !path.startsWith(base)) {
      continue;
    }
    const relative = path.slice(base.length);
    const folder = buildOutputFolder(project.text);
    if (relative === buildManifestPath(folder)) {
      return true;
    }
    if (folder === "" ? EMITTED_IN_PLACE.test(relative) : relative.startsWith(`${folder}/`)) {
      return true;
    }
  }
  return false;
}
