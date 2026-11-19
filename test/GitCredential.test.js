// Behavioral spec for b6p as git's credential helper (src/gitCredential/, src/cache/GitCredentialHosts.ts):
//
//  - `get` answers the stored token only for an https request to an allowed host: the configured gateway's host, or a
//    tenant host a script pull reached. Exact host[:port] match; a lookalike host, another port, http, a userinfo or
//    another username gets nothing (an empty answer, so git asks its other helpers).
//  - `store` and `erase` do nothing, and never touch the stored token.
//  - setup adds `credential.https://<host>.helper` to the global git config for each allowed host, after any helper
//    already there, and a second run adds nothing; removal takes out only b6p's entries. The token never reaches git
//    config's argv.
//  - a successful script pull records its host; a failed one does not.
//  - end to end, `git credential fill` gets the token from the helper, and nothing for a host off the list.
//
// Dependency-free node script (run via `npm test`) over the COMPILED dist/. Needs `git` on PATH.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { createStub } = require("../packages/bsjs-git/test/support/GitProxyStub");
const core = require("../dist/index.js");

const { GitCredentialService, GitCredentialHosts, GitCredentialResets, GitCredential, Err, PublicKeys } = core;
const { ScriptService, SharedFilePersistence, credentialHostOf, requestedCredentialHost, gitConfigRunner } = core;
const { parseCredentialRequest, patternApplies, credentialContextMatch, patternIsHost } = core;

const TOKEN = "b6pt_credentialHelperTestToken";
const GATEWAY = "https://gateway.bluestep.net";
const TENANT = "acme.bluestep.net";

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const noop = () => {};
const warnings = [];
const logger = { debug: noop, info: noop, warn: (m) => warnings.push(String(m)), error: noop };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-core-gitcred-"));
const EMPTY = path.join(tmp, "empty.gitconfig");
fs.writeFileSync(EMPTY, "");
let configN = 0;

/** Public-state persistence in memory (all the store and the service touch). */
function memoryPersistence(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (key) => data[key],
    set: async (key, value) => {
      data[key] = JSON.parse(JSON.stringify(value));
    },
    delete: async (key) => {
      delete data[key];
    },
  };
}

/** A scratch global git config, and the env that points git at it. */
function scratchConfig(text = "") {
  const file = path.join(tmp, `global-${++configN}.gitconfig`);
  fs.writeFileSync(file, text);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: file, GIT_CONFIG_SYSTEM: EMPTY, GIT_CONFIG_NOSYSTEM: "1" };
  return { file, env };
}

function gitGetAll(env, key) {
  const run = spawnSync("git", ["config", "--global", "--null", "--get-all", key], { env, encoding: "utf8" });
  return run.status === 0 ? run.stdout.split("\0").slice(0, -1) : [];
}

/**
 * A service over memory persistence and a scratch git config; `argv` records every git call, and `edits` every file
 * edited. git runs in `tmp` (no repository) unless a call names its own directory. `run`, `git` and `edit` wrap the
 * real runner's calls (each gets the real call as its last argument).
 */
function makeService(options = {}) {
  const persistence = options.persistence ?? memoryPersistence();
  const hosts = new GitCredentialHosts(persistence);
  const config = options.config ?? scratchConfig();
  const real = gitConfigRunner(config.env);
  const argv = [];
  const edits = [];
  const resets = new GitCredentialResets(persistence);
  const at = (o) => ({ ...(o ?? {}), cwd: o?.cwd ?? tmp });
  const service = new GitCredentialService({
    logger,
    token: { token: async () => ("token" in options ? options.token : TOKEN) },
    gatewayUrl: async () => options.gatewayUrl ?? GATEWAY,
    hosts,
    resets,
    gitConfig: {
      run: async (args, o) => {
        argv.push(args);
        const call = (a) => real.run(a, at(o));
        return options.run ? options.run(args, call) : call(args);
      },
      git: async (args, o) => {
        argv.push(args);
        const call = (a) => real.git(a, at(o));
        return options.git ? options.git(args, call) : call(args);
      },
      globalFile: () => real.globalFile(),
      editFile: async (file, edit) => {
        edits.push(file);
        return options.edit ? options.edit(file, edit, real.editFile) : real.editFile(file, edit);
      },
    },
  });
  return { service, hosts, resets, persistence, config, argv, edits };
}

const req = (fields) =>
  Object.entries(fields)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("") + "\n";
const ANSWER = `username=${GitCredential.USERNAME}\npassword=${TOKEN}\n`;

// ── host rules ────────────────────────────────────────────────────────

test("credentialHostOf: https only, no userinfo, the port only when it is not 443", () => {
  assert.strictEqual(credentialHostOf(new URL("https://Acme.BlueStep.net/files/1/")), TENANT);
  assert.strictEqual(credentialHostOf(new URL("https://acme.bluestep.net:443/")), TENANT);
  assert.strictEqual(credentialHostOf(new URL("https://acme.bluestep.net:8443/")), `${TENANT}:8443`);
  assert.strictEqual(credentialHostOf(new URL("http://acme.bluestep.net/")), null);
  assert.strictEqual(credentialHostOf(new URL("https://u:p@acme.bluestep.net/")), null);
  assert.strictEqual(credentialHostOf(new URL("https://u@acme.bluestep.net/")), null);
});

test("requestedCredentialHost: refuses anything the URL parser would rewrite rather than normalizing it", () => {
  assert.strictEqual(requestedCredentialHost("gateway.bluestep.net"), "gateway.bluestep.net");
  assert.strictEqual(requestedCredentialHost("GATEWAY.bluestep.net:443"), "gateway.bluestep.net");
  assert.strictEqual(requestedCredentialHost("localhost:8443"), "localhost:8443");
  // Kept as it is (so it never equals an allowed host), not stripped onto one.
  assert.strictEqual(requestedCredentialHost("gateway.bluestep.net."), "gateway.bluestep.net.");
  for (const bad of [
    "",
    "evil.com/gateway.bluestep.net",
    "user@gateway.bluestep.net",
    "gateway.bluestep.net:",
    "gateway.bluestep.net:8443:443",
    "gateway.bluestep.net::443",
    "0x7f.1",
    "gateway%2ebluestep.net",
    "gateway.bluestep.net\\x",
    "gateway.bluestep.net x",
    "gateway.bluestep.net?x",
  ]) {
    assert.strictEqual(requestedCredentialHost(bad), null, `"${bad}" must not pass`);
  }
});

test("parseCredentialRequest: key=value lines up to the blank line; last value wins; [] keys skipped", () => {
  const fields = parseCredentialRequest("protocol=https\r\nhost=a\nhost=b\nwwwauth[]=Basic\nnoequals\n\nhost=after\n");
  assert.strictEqual(fields.get("protocol"), "https");
  assert.strictEqual(fields.get("host"), "b");
  assert.strictEqual(fields.has("wwwauth[]"), false);
  assert.strictEqual(fields.size, 2);
});

// ── get ───────────────────────────────────────────────────────────────

test("get answers the token for the configured gateway's host", async () => {
  const { service } = makeService();
  assert.strictEqual(await service.answer("get", req({ protocol: "https", host: "gateway.bluestep.net" })), ANSWER);
  assert.strictEqual(
    await service.answer("get", req({ protocol: "https", host: "gateway.bluestep.net", path: "api/v1/git/x.git" })),
    ANSWER
  );
  assert.strictEqual(
    await service.answer("get", req({ protocol: "https", host: "gateway.bluestep.net", username: "b6p" })),
    ANSWER
  );
  assert.strictEqual(
    await service.answer("get", req({ url: "https://gateway.bluestep.net/api/v1/git/x.git" })),
    "",
    "git never sends url= to a helper, so it is refused even when it names an allowed host"
  );
});

test("get answers nothing for a lookalike host, another port, http, a userinfo or another username", async () => {
  const { service } = makeService();
  const refused = [
    { protocol: "https", host: "gateway.bluestep.net.evil.com" },
    { protocol: "https", host: "evil.com/gateway.bluestep.net" },
    { protocol: "https", host: "evilgateway.bluestep.net" },
    { protocol: "https", host: "gateway.bluestep.net:8443" },
    { protocol: "https", host: "gateway.bluestep.net." },
    { protocol: "http", host: "gateway.bluestep.net" },
    { protocol: "https", host: "gateway.bluestep.net", username: "someone-else" },
    { host: "gateway.bluestep.net" },
    { protocol: "https" },
    { url: "https://someone@gateway.bluestep.net/x.git" },
    { url: "http://gateway.bluestep.net/x.git" },
    { url: "https://gateway.bluestep.net.evil.com/x.git" },
    { protocol: "https", host: "evil.com", url: "https://gateway.bluestep.net/x.git" },
    { protocol: "http", url: "https://gateway.bluestep.net/x.git" },
    { url: "not a url" },
    { url: "https://gateway.bluestep.net\\@evil.com/x.git" },
    { protocol: "https", host: "gateway.bluestep.net", url: "https://gateway.bluestep.net/x.git" },
    { protocol: "https", host: TENANT },
  ];
  for (const fields of refused) {
    assert.strictEqual(await service.answer("get", req(fields)), "", JSON.stringify(fields));
  }
});

test("a gateway configured over loopback http, or unusable, is not on the list", async () => {
  for (const gatewayUrl of [
    "http://127.0.0.1:8080",
    "not a url",
    "https://u:p@gateway.example",
    "https://gw.example/path",
  ]) {
    const { service } = makeService({ gatewayUrl });
    assert.deepStrictEqual(await service.allowedHosts(), [], gatewayUrl);
  }
  const { service } = makeService({ gatewayUrl: "https://gw.example:8443" });
  assert.deepStrictEqual(await service.allowedHosts(), [{ host: "gw.example:8443", source: "gateway" }]);
  assert.strictEqual(await service.answer("get", req({ protocol: "https", host: "gw.example:8443" })), ANSWER);
  assert.strictEqual(await service.answer("get", req({ protocol: "https", host: "gw.example" })), "");
  assert.strictEqual(await service.answer("get", req({ protocol: "https", host: "gw.example:8443:443" })), "");
});

test("a tenant host is answered once a pull recorded it; an http or credentialed URL is never recorded", async () => {
  const { service, hosts, persistence } = makeService();
  assert.strictEqual(await service.answer("get", req({ protocol: "https", host: TENANT })), "");
  assert.strictEqual(await hosts.record(`https://${TENANT}/files/123/`), true);
  assert.strictEqual(await hosts.record("http://plain.bluestep.net/"), false);
  assert.strictEqual(await hosts.record("https://u:p@cred.bluestep.net/"), false);
  assert.strictEqual(await hosts.record("not a url"), false);
  assert.deepStrictEqual(await hosts.hosts(), [TENANT]);
  assert.ok(persistence.data[PublicKeys.GIT_CREDENTIAL_HOSTS][TENANT].recordedAt > 0);
  assert.deepStrictEqual(await service.allowedHosts(), [
    { host: "gateway.bluestep.net", source: "gateway" },
    { host: TENANT, source: "script-pull" },
  ]);
  assert.strictEqual(await service.answer("get", req({ protocol: "https", host: TENANT })), ANSWER);
  assert.strictEqual(await service.answer("get", req({ protocol: "https", host: `${TENANT}.evil.com` })), "");
  assert.strictEqual(await service.answer("get", req({ protocol: "https", host: "plain.bluestep.net" })), "");
  assert.strictEqual(await hosts.forget(TENANT), true);
  assert.strictEqual(await hosts.forget(TENANT), false);
  assert.strictEqual(await service.answer("get", req({ protocol: "https", host: TENANT })), "");
});

test("the store reads persistence every time, so another process's recording is seen and kept", async () => {
  const persistence = memoryPersistence();
  const one = new GitCredentialHosts(persistence);
  const two = new GitCredentialHosts(persistence);
  await one.record("https://a.bluestep.net/");
  await two.record("https://b.bluestep.net/");
  assert.deepStrictEqual(await one.hosts(), ["a.bluestep.net", "b.bluestep.net"]);
  const concurrent = new GitCredentialHosts(memoryPersistence());
  await Promise.all([concurrent.record("https://c.bluestep.net/"), concurrent.record("https://d.bluestep.net/")]);
  assert.deepStrictEqual(
    await concurrent.hosts(),
    ["c.bluestep.net", "d.bluestep.net"],
    "neither write lost the other"
  );
  const [forgot] = await Promise.all([
    concurrent.forget("c.bluestep.net"),
    concurrent.record("https://e.bluestep.net/"),
  ]);
  assert.strictEqual(forgot, true);
  assert.deepStrictEqual(await concurrent.hosts(), ["d.bluestep.net", "e.bluestep.net"], "a forget is not undone");
  const broken = new GitCredentialHosts(memoryPersistence({ [PublicKeys.GIT_CREDENTIAL_HOSTS]: ["junk"] }));
  assert.deepStrictEqual(await broken.hosts(), []);
});

test("no stored token, or one unfit for a header, answers nothing", async () => {
  for (const token of [undefined, "", "not-a-b6pt-token", "b6pt_with\nnewline", "b6pt_with space"]) {
    const { service } = makeService({ token });
    assert.strictEqual(await service.answer("get", req({ protocol: "https", host: "gateway.bluestep.net" })), "");
  }
});

test("a failure reading the token answers nothing and logs no detail", async () => {
  warnings.length = 0;
  const persistence = memoryPersistence();
  const service = new GitCredentialService({
    logger,
    token: {
      token: async () => {
        throw new Error(`boom ${TOKEN}`);
      },
    },
    gatewayUrl: async () => GATEWAY,
    hosts: new GitCredentialHosts(persistence),
    resets: new GitCredentialResets(persistence),
    gitConfig: {
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      git: async () => ({ code: 0, stdout: "", stderr: "" }),
      globalFile: async () => EMPTY,
      editFile: async () => false,
    },
  });
  assert.strictEqual(await service.answer("get", req({ protocol: "https", host: "gateway.bluestep.net" })), "");
  assert.strictEqual(warnings.length, 1);
  assert.ok(!warnings[0].includes(TOKEN));
});

test("store and erase do nothing, and the token is still answered after an erase", async () => {
  const { service } = makeService();
  const request = req({ protocol: "https", host: "gateway.bluestep.net", username: "b6p", password: TOKEN });
  assert.strictEqual(await service.answer("store", request), "");
  assert.strictEqual(await service.answer("erase", request), "");
  assert.strictEqual(await service.answer("frobnicate", request), "");
  assert.strictEqual(await service.answer("get", req({ protocol: "https", host: "gateway.bluestep.net" })), ANSWER);
});

// ── setup and removal ─────────────────────────────────────────────────

test("setup writes a reset then b6p per allowed host, like gh; a second run adds nothing", async () => {
  const config = scratchConfig(
    '[credential]\n\thelper = cache\n[credential "https://gateway.bluestep.net"]\n\thelper = other-helper\n'
  );
  const { service, hosts, argv } = makeService({ config });
  await hosts.record(`https://${TENANT}/`);
  const before = await service.setupStatus();
  assert.strictEqual(before.configured, false);
  assert.deepStrictEqual(before.otherHelpers, ["cache"]);
  assert.deepStrictEqual(
    before.hosts.map((h) => [h.host, h.configured, h.alsoAsked]),
    [
      ["gateway.bluestep.net", false, ["cache", "other-helper"]],
      [TENANT, false, ["cache"]],
    ]
  );

  const first = await service.setupGit();
  assert.deepStrictEqual(first.added, ["gateway.bluestep.net", TENANT]);
  assert.deepStrictEqual(first.alreadyConfigured, []);
  assert.deepStrictEqual(first.otherHelpers, ["cache"]);
  assert.deepStrictEqual(
    first.hosts.map((h) => [h.host, h.configured, h.alsoAsked]),
    [
      ["gateway.bluestep.net", true, []],
      [TENANT, true, []],
    ],
    "after the reset git asks b6p alone: neither cache nor other-helper sees the token"
  );
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper"), [
    "other-helper",
    "",
    GitCredential.DEFAULT_HELPER,
  ]);
  assert.deepStrictEqual(gitGetAll(config.env, `credential.https://${TENANT}.helper`), [
    "",
    GitCredential.DEFAULT_HELPER,
  ]);
  assert.deepStrictEqual(gitGetAll(config.env, "credential.helper"), ["cache"]);

  const second = await service.setupGit();
  assert.deepStrictEqual(second.added, []);
  assert.deepStrictEqual(second.alreadyConfigured, ["gateway.bluestep.net", TENANT]);
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper"), [
    "other-helper",
    "",
    GitCredential.DEFAULT_HELPER,
  ]);
  assert.deepStrictEqual(gitGetAll(config.env, `credential.https://${TENANT}.helper`), [
    "",
    GitCredential.DEFAULT_HELPER,
  ]);
  assert.strictEqual((await service.setupStatus()).configured, true);
  assert.ok(
    argv.flat().every((arg) => !arg.includes(TOKEN)),
    "the token never reaches git config's argv"
  );
});

test("b6p's entry followed by a reset is not configured (git never asks it); setup puts it back last, once", async () => {
  const config = scratchConfig(
    `[credential "https://gateway.bluestep.net"]\n\thelper = ${GitCredential.DEFAULT_HELPER}\n\thelper =\n`
  );
  const { service } = makeService({ config });
  const status = await service.setupStatus();
  assert.strictEqual(status.hosts[0].configured, false);
  assert.deepStrictEqual(status.hosts[0].alsoAsked, []);
  await service.setupGit();
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper"), [
    "",
    "",
    GitCredential.DEFAULT_HELPER,
  ]);
  assert.strictEqual((await service.setupStatus()).configured, true);
  await service.setupGit();
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper"), [
    "",
    "",
    GitCredential.DEFAULT_HELPER,
  ]);
});

test("a generic helper later in the file than b6p's reset leaves the host not configured, the entry named", async () => {
  const config = scratchConfig();
  const { service } = makeService({ config });
  await service.setupGit();
  fs.appendFileSync(config.file, "[credential]\n\thelper = store\n");
  const status = await service.setupStatus();
  assert.strictEqual(status.hosts[0].configured, false, "store would be told to keep the token");
  assert.deepStrictEqual(status.hosts[0].alsoAsked, ["store"]);
  assert.deepStrictEqual(status.hosts[0].others, [{ key: "credential.helper", value: "store", file: config.file }]);
  assert.deepStrictEqual(status.otherHelpers, ["store"]);
});

test("a host recorded after setup reports not configured until setup runs again; a custom helper command", async () => {
  const { service, hosts, config } = makeService();
  const custom = "!/opt/b6p/bin/b6p auth git-credential";
  await service.setupGit({ helper: custom });
  assert.strictEqual((await service.setupStatus({ helper: custom })).configured, true);
  assert.strictEqual((await service.setupStatus()).configured, false, "the default command is not what was written");
  await hosts.record(`https://${TENANT}/`);
  const status = await service.setupStatus({ helper: custom });
  assert.strictEqual(status.configured, false);
  assert.deepStrictEqual(
    status.hosts.map((h) => [h.host, h.configured]),
    [
      ["gateway.bluestep.net", true],
      [TENANT, false],
    ]
  );
  await assert.rejects(service.setupGit({ helper: "two\nlines" }), Err.GitCredentialSetupError);
  assert.deepStrictEqual(gitGetAll(config.env, `credential.https://${TENANT}.helper`), []);
});

test("with no allowed host, setup changes nothing and reports not configured", async () => {
  const { service, config } = makeService({ gatewayUrl: "http://127.0.0.1:1" });
  const result = await service.setupGit();
  assert.deepStrictEqual(result.added, []);
  assert.strictEqual((await service.setupStatus()).configured, false);
  assert.strictEqual(fs.readFileSync(config.file, "utf8"), "");
});

test("removal takes out b6p's entries and the resets it recorded only, a host no longer allowed included", async () => {
  const config = scratchConfig(
    "[credential]\n\thelper = store\n" +
      '[credential "https://gateway.bluestep.net"]\n\thelper = other-helper\n' +
      `[credential "https://old.bluestep.net"]\n\thelper =\n\thelper = ${GitCredential.DEFAULT_HELPER}\n\thelper = ${GitCredential.DEFAULT_HELPER}\n` +
      '[credential "https://github.com"]\n\thelper =\n\thelper = !/usr/bin/gh auth git-credential\n'
  );
  const { service } = makeService({ config });
  await service.setupGit();
  const result = await service.removeGit();
  assert.deepStrictEqual(result.removed.sort(), ["https://gateway.bluestep.net", "https://old.bluestep.net"]);
  assert.deepStrictEqual(result.keptResets, []);
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper"), ["other-helper"]);
  assert.deepStrictEqual(
    gitGetAll(config.env, "credential.https://old.bluestep.net.helper"),
    [""],
    "b6p never recorded writing that reset, so it stays"
  );
  assert.deepStrictEqual(gitGetAll(config.env, "credential.helper"), ["store"]);
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://github.com.helper"), [
    "",
    "!/usr/bin/gh auth git-credential",
  ]);
  assert.deepStrictEqual((await service.removeGit()).removed, [], "a second run removes nothing");
  // A custom command is removed only when named.
  await service.setupGit({ helper: "!/opt/b6p auth git-credential" });
  assert.deepStrictEqual((await service.removeGit()).removed, []);
  assert.deepStrictEqual((await service.removeGit({ helpers: ["!/opt/b6p auth git-credential"] })).removed, [
    "https://gateway.bluestep.net",
  ]);
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper"), ["other-helper"]);
});

test("a reset the user wrote is never removed: not one away from b6p's entry, nor one git config cannot tell apart", async () => {
  // The user's reset sits before their own helper, not immediately before b6p's entry.
  const config = scratchConfig(
    `[credential "https://gateway.bluestep.net"]\n\thelper =\n\thelper = mine\n[credential "https://${TENANT}"]\n\thelper =\n\thelper = mine\n\thelper =\n\thelper = ${GitCredential.DEFAULT_HELPER}\n`
  );
  const { service, hosts } = makeService({ config });
  await hosts.record(`https://${TENANT}/`);
  await service.setupGit();
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper"), [
    "",
    "mine",
    "",
    GitCredential.DEFAULT_HELPER,
  ]);
  const result = await service.removeGit();
  assert.deepStrictEqual(result.removed.sort(), ["https://acme.bluestep.net", "https://gateway.bluestep.net"]);
  // The gateway's key holds the user's empty value beside b6p's pair; b6p's pair is the one reset directly followed by
  // its helper, so it goes, both lines in one edit, and the user's stays. The tenant's reset was never b6p's (setup
  // found the host configured and wrote nothing), so it stays and is not reported.
  assert.deepStrictEqual(result.keptResets, []);
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper"), ["", "mine"]);
  assert.deepStrictEqual(gitGetAll(config.env, `credential.https://${TENANT}.helper`), ["", "mine", ""]);
});

/** A scratch HOME with no GIT_CONFIG_GLOBAL, so git reads ~/.gitconfig and $XDG_CONFIG_HOME/git/config. */
function scratchHome(files) {
  const home = fs.mkdtempSync(path.join(tmp, "home-"));
  const xdg = path.join(home, "xdg");
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_NOSYSTEM: "1" };
  delete env.GIT_CONFIG_GLOBAL;
  delete env.GIT_CONFIG_SYSTEM;
  return { home, env, read: (rel) => fs.readFileSync(path.join(home, rel), "utf8") };
}

function entriesOf(env, file) {
  const run = spawnSync("git", ["config", "--file", file, "--null", "--list"], { env, encoding: "utf8" });
  return run.status === 0 ? run.stdout.split("\0").slice(0, -1) : [];
}

test("an included file and $XDG_CONFIG_HOME/git/config are read, and removal edits the file each entry came from", async () => {
  const pair = (host) => `[credential "https://${host}"]\n\thelper =\n\thelper = ${GitCredential.DEFAULT_HELPER}\n`;
  // git reads the XDG file first, then ~/.gitconfig and what it includes.
  const scratch = scratchHome({
    ".gitconfig": "[include]\n\tpath = inc.gitconfig\n[user]\n\tname = Someone\n",
    "inc.gitconfig": pair("gateway.bluestep.net"),
    "xdg/git/config": "[credential]\n\thelper = store\n" + pair(TENANT),
  });
  const inc = path.join(scratch.home, "inc.gitconfig");
  const xdg = path.join(scratch.home, "xdg", "git", "config");
  const persistence = memoryPersistence();
  const { service, hosts, resets } = makeService({ config: { env: scratch.env }, persistence });
  // As a setup that wrote these would have recorded them.
  await resets.put(inc, "credential.https://gateway.bluestep.net.helper", {
    state: "installed",
    helper: GitCredential.DEFAULT_HELPER,
  });
  await resets.put(xdg, `credential.https://${TENANT}.helper`, {
    state: "installed",
    helper: GitCredential.DEFAULT_HELPER,
  });
  await hosts.record(`https://${TENANT}/`);
  const status = await service.setupStatus();
  assert.deepStrictEqual(status.otherHelpers, ["store"], "a generic helper in the XDG file is seen");
  assert.strictEqual(status.configured, true, "entries in an included file and in the XDG file count");
  const again = await service.setupGit();
  assert.deepStrictEqual(again.added, [], "nothing is duplicated into ~/.gitconfig");
  assert.strictEqual(scratch.read(".gitconfig"), "[include]\n\tpath = inc.gitconfig\n[user]\n\tname = Someone\n");

  const result = await service.removeGit();
  assert.deepStrictEqual(result.removed.sort(), [`https://${TENANT}`, "https://gateway.bluestep.net"]);
  assert.deepStrictEqual(result.keptResets, []);
  assert.deepStrictEqual(entriesOf(scratch.env, inc), []);
  assert.deepStrictEqual(entriesOf(scratch.env, xdg), ["credential.helper\nstore"]);
  assert.strictEqual(scratch.read(".gitconfig"), "[include]\n\tpath = inc.gitconfig\n[user]\n\tname = Someone\n");
  assert.deepStrictEqual(await resets.all(), {});
});

test("with only $XDG_CONFIG_HOME/git/config, setup writes there and removal takes it out again", async () => {
  const scratch = scratchHome({ "xdg/git/config": "[credential]\n\thelper = cache\n" });
  const { service } = makeService({ config: { env: scratch.env } });
  const result = await service.setupGit();
  assert.deepStrictEqual(result.added, ["gateway.bluestep.net"]);
  assert.strictEqual(fs.existsSync(path.join(scratch.home, ".gitconfig")), false);
  const xdg = path.join(scratch.home, "xdg", "git", "config");
  assert.deepStrictEqual(entriesOf(scratch.env, xdg), [
    "credential.helper\ncache",
    "credential.https://gateway.bluestep.net.helper\n",
    `credential.https://gateway.bluestep.net.helper\n${GitCredential.DEFAULT_HELPER}`,
  ]);
  await service.removeGit();
  assert.deepStrictEqual(entriesOf(scratch.env, xdg), ["credential.helper\ncache"]);
});

test("a git config failure or a missing git is a GitCredentialSetupError with no token in it", async () => {
  const failing = makeService({
    run: async () => ({ code: 3, stdout: "", stderr: "error: could not lock config file\nmore" }),
  });
  const error = await failing.service.setupGit().then(
    () => assert.fail("expected a rejection"),
    (e) => e
  );
  assert.ok(error instanceof Err.GitCredentialSetupError);
  assert.strictEqual(error.exitCode, 3);
  assert.match(error.message, /could not lock config file/);
  assert.ok(!error.message.includes("more"));
  const missing = makeService({ run: async () => ({ code: -1, stdout: "", stderr: "" }) });
  await assert.rejects(
    missing.service.removeGit(),
    (e) => e instanceof Err.GitCredentialSetupError && e.exitCode === null
  );
  const noGit = gitConfigRunner({ PATH: path.join(tmp, "no-such-dir") });
  assert.strictEqual((await noGit.run(["--list"])).code, -1);
});

// ── git's credential contexts ─────────────────────────────────────────

const CONTEXT_CASES = {
  yes: [
    null,
    "https://gateway.bluestep.net",
    "https://gateway.bluestep.net/",
    "https://GATEWAY.bluestep.net",
    "HTTPS://gateway.bluestep.net",
    "https://gateway.bluestep.net:443",
    "https://gateway.bluestep.net:0443",
    "https://gateway.bluestep.net:",
    "https://*.bluestep.net",
    "https://gateway.*.net",
    "https://gateway.bluestep.net/.",
    "https://gateway.bluestep.net/a/..",
    "https://",
  ],
  maybe: [
    "https://gateway.bluestep.net/api/v1/git/",
    "https://gateway.bluestep.net/api/v1/git/kb.git",
    "https://b6p@gateway.bluestep.net",
    "https://b%36p@gateway.bluestep.net",
    "gateway.bluestep.net",
    "https://gateway%2ebluestep.net",
    "/api/v1/git/kb.git",
  ],
  no: [
    "http://gateway.bluestep.net",
    "ssh://gateway.bluestep.net",
    "http://",
    "https://gateway.bluestep.net:8443",
    "https://gateway.bluestep.net:0",
    "https://other.bluestep.net",
    "https://*.gateway.bluestep.net",
    "https://bluestep.net",
    "https://*.example.com",
    "https://gate*.bluestep.net",
    "*.bluestep.net",
    "GATEWAY.bluestep.net:8443",
  ],
};

// Patterns naming another user: git never asks them for a request b6p answers as it arrives, but a remote URL naming
// that user brings them in, and one answering `username=b6p` makes git ask b6p next, so b6p counts them as `maybe`.
const OTHER_USER_CASES = [
  "https://someone@gateway.bluestep.net",
  "https://alice@*.bluestep.net",
  "alice@gateway.bluestep.net",
];

test("credentialContextMatch: yes, no or maybe for each pattern, as git 2.53's credential contexts decide", () => {
  const host = "gateway.bluestep.net";
  for (const url of OTHER_USER_CASES) {
    assert.strictEqual(credentialContextMatch(url, host), "maybe", url);
  }
  assert.strictEqual(
    credentialContextMatch("https://alice@other.bluestep.net", host),
    "no",
    "another host still is not"
  );
  for (const [want, urls] of Object.entries(CONTEXT_CASES)) {
    for (const url of urls) {
      assert.strictEqual(credentialContextMatch(url, host), want, String(url));
      assert.strictEqual(patternApplies(url, host), want !== "no", String(url));
    }
  }
  assert.strictEqual(credentialContextMatch("https://gw.example:8443/", "gw.example:8443"), "yes");
  assert.strictEqual(credentialContextMatch("https://gw.example:08443", "gw.example:8443"), "yes");
  assert.strictEqual(credentialContextMatch("https://gw.example", "gw.example:8443"), "no");
  assert.strictEqual(credentialContextMatch("gw.example:8443", "gw.example:8443"), "maybe");
  assert.strictEqual(patternIsHost("https://GATEWAY.bluestep.net:0443/", host), true);
  for (const url of ["https://*.bluestep.net", "https://b6p@gateway.bluestep.net", "https://gateway.bluestep.net/x"]) {
    assert.strictEqual(patternIsHost(url, host), false, url);
  }
});

test("the cases above are what real git 2.53 does: yes asks for every request b6p answers, no for none, maybe some", () => {
  // The requests b6p answers for the host: any case, `:443` or not, any path, no username or `b6p`.
  const requests = [
    "protocol=https\nhost=gateway.bluestep.net\n",
    "protocol=https\nhost=GATEWAY.BLUESTEP.NET\n",
    "protocol=https\nhost=gateway.bluestep.net:443\n",
    "protocol=https\nhost=gateway.bluestep.net\npath=api/v1/git/kb.git\n",
    "protocol=https\nhost=gateway.bluestep.net\nusername=b6p\n",
  ];
  const marks = path.join(tmp, `marks-${++configN}`);
  const helper = `!f() { echo x >> "${marks.replace(/\\/g, "/")}"; echo username=u; echo password=p; }; f`;
  for (const [want, urls] of Object.entries(CONTEXT_CASES)) {
    for (const url of urls) {
      const config = scratchConfig();
      execFileSync(
        "git",
        ["config", "--global", url === null ? "credential.helper" : `credential.${url}.helper`, helper],
        {
          env: config.env,
        }
      );
      let asked = 0;
      for (const request of requests) {
        fs.rmSync(marks, { force: true });
        credential("fill", request + "\n", config.env);
        asked += fs.existsSync(marks) ? 1 : 0;
      }
      const seen = asked === requests.length ? "yes" : asked === 0 ? "no" : "maybe";
      assert.strictEqual(seen, want, `${url}: git asked for ${asked} of ${requests.length}`);
    }
  }
});

test("a wildcard, port, trailing-slash or path entry after b6p's leaves the host not configured, the entry named", async () => {
  for (const url of [
    "https://*.bluestep.net",
    "https://gateway.bluestep.net:443",
    "https://gateway.bluestep.net/",
    "https://gateway.bluestep.net/api/v1/git/kb.git",
  ]) {
    const config = scratchConfig();
    const { service } = makeService({ config });
    await service.setupGit();
    execFileSync("git", ["config", "--global", "--add", `credential.${url}.helper`, "store"], { env: config.env });
    const status = await service.setupStatus();
    assert.strictEqual(status.hosts[0].configured, false, url);
    assert.deepStrictEqual(status.hosts[0].alsoAsked, ["store"], url);
    assert.deepStrictEqual(status.hosts[0].others, [
      { key: `credential.${url}.helper`, value: "store", file: config.file },
    ]);
    // Setup never moves the user's entry. It takes its own pair out and appends it again: where git drops the emptied
    // section (git 2.53 does), the pair lands after the user's entry and the host is set up; where git keeps the
    // section, the pair goes back into it and the entry is reported again. Either way nothing is doubled.
    const again = await service.setupGit();
    const host = again.hosts[0];
    assert.ok(host.configured ? host.alsoAsked.length === 0 : host.alsoAsked[0] === "store", url);
    const values = gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper");
    assert.deepStrictEqual(values, ["", GitCredential.DEFAULT_HELPER], url);
  }
  // The same entries before b6p's reset are cleared by it.
  const config = scratchConfig('[credential "https://*.bluestep.net"]\n\thelper = store\n');
  const { service } = makeService({ config });
  const result = await service.setupGit();
  assert.strictEqual(result.hosts[0].configured, true);
  assert.deepStrictEqual(result.hosts[0].alsoAsked, []);
});

/** `git credential <action>` for `input` in `env`. */
function credential(action, input, env) {
  return spawnSync("git", ["credential", action], {
    input,
    encoding: "utf8",
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
  });
}

test("end to end: a store helper on *.bluestep.net never gets the token after setup; added after, status says so", async () => {
  const storeFile = path.join(tmp, `store-${++configN}`).replace(/\\/g, "/");
  const scratch = scratchHome({
    ".gitconfig": `[credential "https://*.bluestep.net"]\n\thelper = store --file=${storeFile}\n`,
  });
  const stateFile = path.join(tmp, `state-${++configN}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({ token: TOKEN, gatewayUrl: GATEWAY, public: {} }));
  const script = path.join(__dirname, "support", "GitCredentialHelper.js").replace(/\\/g, "/");
  const helper = `!"${process.execPath.replace(/\\/g, "/")}" "${script}" "${stateFile.replace(/\\/g, "/")}"`;
  const { service } = makeService({ config: { env: scratch.env } });
  const result = await service.setupGit({ helper });
  assert.strictEqual(result.hosts[0].configured, true);

  const request = "protocol=https\nhost=gateway.bluestep.net\n\n";
  const filled = credential("fill", request, scratch.env);
  assert.strictEqual(filled.status, 0, filled.stderr);
  assert.match(filled.stdout, new RegExp(`^password=${TOKEN}$`, "m"));
  const approved = credential("approve", filled.stdout + "\n", scratch.env);
  assert.strictEqual(approved.status, 0, approved.stderr);
  assert.ok(!fs.existsSync(storeFile) || !fs.readFileSync(storeFile, "utf8").includes(TOKEN), "store never saw it");

  // The same helper added after b6p's: status reports it, and git does hand it the token.
  execFileSync(
    "git",
    // A new section (the trailing slash), so it lands after b6p's rather than in the user's first one.
    ["config", "--global", "--add", "credential.https://*.bluestep.net/.helper", `store --file=${storeFile}`],
    {
      env: scratch.env,
    }
  );
  const status = await service.setupStatus({ helper });
  assert.strictEqual(status.hosts[0].configured, false);
  assert.deepStrictEqual(status.hosts[0].alsoAsked, [`store --file=${storeFile}`]);
  credential("approve", credential("fill", request, scratch.env).stdout + "\n", scratch.env);
  assert.ok(fs.readFileSync(storeFile, "utf8").includes(TOKEN), "git really does give it to the later store");
});

// ── ownership of resets ───────────────────────────────────────────────

test("a reset b6p did not record is never removed, even right before b6p's entry with another key between", async () => {
  const config = scratchConfig(
    `[credential "https://gateway.bluestep.net"]\n\thelper =\n\tusername = b6p\n\thelper = ${GitCredential.DEFAULT_HELPER}\n`
  );
  const { service, resets } = makeService({ config });
  const setup = await service.setupGit();
  assert.deepStrictEqual(setup.alreadyConfigured, ["gateway.bluestep.net"], "git already asks only b6p");
  assert.deepStrictEqual(await resets.all(), {}, "nothing was written, so nothing is b6p's");
  const result = await service.removeGit();
  assert.deepStrictEqual(result.removed, ["https://gateway.bluestep.net"]);
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper"), [""]);
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.username"), ["b6p"]);
});

test("setup records each reset it writes: file, exact key and the helper after it", async () => {
  const config = scratchConfig();
  const { service, resets, persistence } = makeService({ config });
  await service.setupGit();
  assert.deepStrictEqual(await resets.all(), {
    [config.file]: {
      "credential.https://gateway.bluestep.net.helper": { state: "installed", helper: GitCredential.DEFAULT_HELPER },
    },
  });
  assert.ok(persistence.data[PublicKeys.GIT_CREDENTIAL_RESETS]);
  await service.removeGit();
  assert.deepStrictEqual(await resets.all(), {});
});

/**
 * `run` and `edit` wrappers for one fault: on the first config write `match` picks (a `git config` add or unset, whose
 * args it is given, or a file edit, for which it is given `null`), `before` runs first, as another writer would; then
 * the write fails (`fail`), runs and is followed by a throw like a process that died just after (`crash`), throws
 * without running, like one that died just before (`die`), or just runs (`go`).
 */
function faultOn(match, mode, before) {
  let fired = false;
  const fire = async (doIt, failed) => {
    fired = true;
    if (before) {
      await before();
    }
    if (mode === "fail") {
      return failed();
    }
    if (mode === "go") {
      return doIt();
    }
    if (mode !== "die") {
      await doIt();
    }
    throw new Error("the process stopped here");
  };
  return {
    run: async (args, real) => {
      if (!fired && isWrite(args) && match(args)) {
        return fire(
          () => real(args),
          () => ({ code: 255, stdout: "", stderr: "error: could not lock config file" })
        );
      }
      return real(args);
    },
    edit: async (file, edit, real) => {
      if (!fired && match(null)) {
        return fire(
          () => real(file, edit),
          () => {
            throw new Err.GitCredentialSetupError("error: could not lock config file", null);
          }
        );
      }
      return real(file, edit);
    },
  };
}
const isWrite = (args) => args.some((a) => a === "--add" || a.startsWith("--unset"));
const anyWrite = () => true;
const addsHelper = (args) =>
  args === null || (args.includes("--add") && args[args.length - 1] === GitCredential.DEFAULT_HELPER);
const userReset = (file) => () =>
  execFileSync("git", ["config", "--file", file, "--add", "credential.https://gateway.bluestep.net.helper", ""]);

test("a setup whose write fails changes nothing, and a retry writes one pair", async () => {
  const config = scratchConfig("[credential]\n\thelper = cache\n");
  const persistence = memoryPersistence();
  for (const match of [anyWrite, addsHelper]) {
    const failing = makeService({ config, persistence, ...faultOn(match, "fail") });
    await assert.rejects(failing.service.setupGit(), Err.GitCredentialSetupError);
    assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper"), []);
    assert.deepStrictEqual(await failing.resets.all(), {});
  }
  const retry = makeService({ config, persistence });
  await retry.service.setupGit();
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper"), [
    "",
    GitCredential.DEFAULT_HELPER,
  ]);
});

test("a setup that stopped after writing is finished by a retry with one pair, and removal leaves none", async () => {
  const config = scratchConfig("[credential]\n\thelper = cache\n");
  const persistence = memoryPersistence();
  const crashed = makeService({ config, persistence, ...faultOn(addsHelper, "crash") });
  await assert.rejects(crashed.service.setupGit(), /the process stopped here/);
  const retry = makeService({ config, persistence });
  const result = await retry.service.setupGit();
  assert.strictEqual(result.hosts[0].configured, true);
  assert.deepStrictEqual(result.alreadyConfigured, ["gateway.bluestep.net"], "the pair the crashed run wrote is b6p's");
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper"), [
    "",
    GitCredential.DEFAULT_HELPER,
  ]);
  assert.deepStrictEqual(await retry.resets.all(), {
    [config.file]: {
      "credential.https://gateway.bluestep.net.helper": { state: "installed", helper: GitCredential.DEFAULT_HELPER },
    },
  });
  await retry.service.removeGit();
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper"), []);
  assert.deepStrictEqual(gitGetAll(config.env, "credential.helper"), ["cache"]);
  assert.deepStrictEqual(await retry.resets.all(), {});
});

test("a setup stopped at any point leaves no reset of b6p's once the next setup and removal have run", async () => {
  // Round 3 wrote the reset and the helper in two calls, so a stop between them left a reset nobody could claim.
  for (const match of [anyWrite, addsHelper]) {
    for (const mode of ["die", "crash"]) {
      const config = scratchConfig("[credential]\n\thelper = cache\n");
      const persistence = memoryPersistence();
      const crashed = makeService({ config, persistence, ...faultOn(match, mode) });
      await crashed.service.setupGit().catch(() => undefined);
      const next = makeService({ config, persistence });
      assert.strictEqual((await next.service.setupGit()).hosts[0].configured, true);
      const removed = await next.service.removeGit();
      const label = `${match.name || "addsHelper"} ${mode}`;
      assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), [], `${label}: no reset of b6p's is left`);
      assert.deepStrictEqual(removed.keptResets, [], label);
      assert.deepStrictEqual(gitGetAll(config.env, "credential.helper"), ["cache"], label);
    }
  }
});

test("a removal, or a setup replacing b6p's pair, stopped at any point never leaves b6p's helper without its reset", async () => {
  const alone = (values) =>
    values.some((v, i) => v === GitCredential.DEFAULT_HELPER && values[i - 1] !== "") ? values.join("|") : null;
  for (const mode of ["die", "crash"]) {
    const config = scratchConfig("[credential]\n\thelper = cache\n");
    const persistence = memoryPersistence();
    await makeService({ config, persistence }).service.setupGit();
    const crashed = makeService({ config, persistence, ...faultOn(anyWrite, mode) });
    await crashed.service.removeGit().catch(() => undefined);
    assert.strictEqual(alone(gitGetAll(config.env, GW_KEY)), null, `removal, ${mode}`);
    await makeService({ config, persistence }).service.removeGit();
    assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), [], `removal, ${mode}: the next run finishes`);

    // Setup takes its own pair out before appending it again, when a helper after it applies.
    await makeService({ config, persistence }).service.setupGit();
    fs.appendFileSync(config.file, '[credential "https://gateway.bluestep.net/"]\n\thelper = store\n');
    const replacing = makeService({ config, persistence, ...faultOn(anyWrite, mode) });
    await replacing.service.setupGit().catch(() => undefined);
    assert.strictEqual(alone(gitGetAll(config.env, GW_KEY)), null, `setup, ${mode}`);
    const next = makeService({ config, persistence });
    assert.strictEqual((await next.service.setupGit()).hosts[0].configured, true, `setup, ${mode}`);
  }
});

test("a reset another writer adds while removal runs survives it, and so does one added while setup's write fails", async () => {
  // Removal: the user's reset lands in b6p's section, after b6p's helper, just before b6p edits the file.
  const config = scratchConfig();
  const persistence = memoryPersistence();
  await makeService({ config, persistence }).service.setupGit();
  const racing = makeService({ config, persistence, ...faultOn(anyWrite, "go", userReset(config.file)) });
  const result = await racing.service.removeGit();
  assert.deepStrictEqual(result.removed, ["https://gateway.bluestep.net"]);
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), [""], "the reset added during removal stays");

  // Setup: the user's reset lands just before b6p's write, which then fails; nothing b6p undoes takes it.
  const other = scratchConfig("[credential]\n\thelper = cache\n");
  const failing = makeService({ config: other, ...faultOn(addsHelper, "fail", userReset(other.file)) });
  await assert.rejects(failing.service.setupGit(), Err.GitCredentialSetupError);
  assert.deepStrictEqual(gitGetAll(other.env, GW_KEY), [""], "the reset added during setup stays");
});

test("removal takes out b6p's entries in every spelling of the URL", async () => {
  const pair = (url) => `[credential "${url}"]\n\thelper =\n\thelper = ${GitCredential.DEFAULT_HELPER}\n`;
  const config = scratchConfig(pair("https://gateway.bluestep.net") + pair("https://GATEWAY.bluestep.net"));
  const { service, resets } = makeService({ config });
  await resets.put(config.file, "credential.https://gateway.bluestep.net.helper", {
    state: "installed",
    helper: GitCredential.DEFAULT_HELPER,
  });
  await resets.put(config.file, "credential.https://GATEWAY.bluestep.net.helper", {
    state: "installed",
    helper: GitCredential.DEFAULT_HELPER,
  });
  const result = await service.removeGit();
  assert.deepStrictEqual(result.removed.sort(), ["https://GATEWAY.bluestep.net", "https://gateway.bluestep.net"]);
  assert.deepStrictEqual(result.keptResets, []);
  assert.deepStrictEqual(entriesOf(config.env, config.file), []);
});

// ── round 3: what applies, who owns a reset, locks ────────────────────

const GW_KEY = "credential.https://gateway.bluestep.net.helper";

test("a reset scoped to a path does not hide an earlier helper: not configured, and setup repairs it", async () => {
  const config = scratchConfig(
    "[credential]\n\thelper = store\n" +
      '[credential "https://gateway.bluestep.net/special"]\n\thelper =\n' +
      `[credential "https://gateway.bluestep.net"]\n\thelper = ${GitCredential.DEFAULT_HELPER}\n`
  );
  const { service } = makeService({ config });
  const status = await service.setupStatus();
  assert.strictEqual(status.hosts[0].configured, false, "outside /special git asks store too");
  assert.deepStrictEqual(status.hosts[0].alsoAsked, ["store"]);
  const result = await service.setupGit();
  assert.deepStrictEqual(result.added, ["gateway.bluestep.net"]);
  assert.strictEqual(result.hosts[0].configured, true);
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), ["", GitCredential.DEFAULT_HELPER]);
});

test("a reset that may apply after b6p's entry leaves the host not configured, and setup puts b6p after it", async () => {
  const config = scratchConfig();
  const { service } = makeService({ config });
  await service.setupGit();
  fs.appendFileSync(config.file, '[credential "https://gateway.bluestep.net/special"]\n\thelper =\n');
  const status = await service.setupStatus();
  assert.strictEqual(status.hosts[0].configured, false, "under /special git asks nobody");
  assert.deepStrictEqual(status.hosts[0].others, [
    { key: "credential.https://gateway.bluestep.net/special.helper", value: "", file: config.file },
  ]);
  const result = await service.setupGit();
  assert.strictEqual(result.hosts[0].configured, true);
});

for (const url of ["https://", "https://gateway.bluestep.net:0443"]) {
  test(`end to end: a store helper on ${url} after b6p's pair is reported, gets the token from git, and setup fixes it`, async () => {
    const storeFile = path.join(tmp, `store-${++configN}`).replace(/\\/g, "/");
    const scratch = scratchHome({});
    const stateFile = path.join(tmp, `state-${++configN}.json`);
    fs.writeFileSync(stateFile, JSON.stringify({ token: TOKEN, gatewayUrl: GATEWAY, public: {} }));
    const script = path.join(__dirname, "support", "GitCredentialHelper.js").replace(/\\/g, "/");
    const helper = `!"${process.execPath.replace(/\\/g, "/")}" "${script}" "${stateFile.replace(/\\/g, "/")}"`;
    const { service } = makeService({ config: { env: scratch.env } });
    assert.strictEqual((await service.setupGit({ helper })).hosts[0].configured, true);
    execFileSync("git", ["config", "--global", "--add", `credential.${url}.helper`, `store --file=${storeFile}`], {
      env: scratch.env,
    });
    const status = await service.setupStatus({ helper });
    assert.strictEqual(status.hosts[0].configured, false, url);
    assert.deepStrictEqual(status.hosts[0].alsoAsked, [`store --file=${storeFile}`]);
    const request = "protocol=https\nhost=gateway.bluestep.net\n\n";
    credential("approve", credential("fill", request, scratch.env).stdout + "\n", scratch.env);
    assert.ok(fs.readFileSync(storeFile, "utf8").includes(TOKEN), "git really does give it to that store");

    fs.rmSync(storeFile);
    const fixed = await service.setupGit({ helper });
    assert.deepStrictEqual(fixed.added, ["gateway.bluestep.net"]);
    assert.strictEqual(fixed.hosts[0].configured, true);
    const filled = credential("fill", request, scratch.env);
    assert.match(filled.stdout, new RegExp(`^password=${TOKEN}$`, "m"));
    credential("approve", filled.stdout + "\n", scratch.env);
    assert.ok(!fs.existsSync(storeFile) || !fs.readFileSync(storeFile, "utf8").includes(TOKEN), "store never saw it");
  });
}

test("a recorded reset whose b6p helper the user took out is no longer b6p's: removal deletes nothing", async () => {
  const mine = '[credential "https://gateway.bluestep.net"]\n\thelper =\n\thelper = store\n';
  const config = scratchConfig(mine + "[credential]\n\thelper = cache\n");
  const { service, resets } = makeService({ config });
  await service.setupGit();
  // b6p's pair went into the user's section, after their own reset and helper.
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), ["", "store", "", GitCredential.DEFAULT_HELPER]);
  // The user deletes b6p's pair by hand, leaving one empty value: the count alone would still match the record.
  fs.writeFileSync(config.file, mine + "[credential]\n\thelper = cache\n");
  const result = await service.removeGit();
  assert.deepStrictEqual(result, { removed: [], keptResets: [] });
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), ["", "store"], "the user's reset stays");
  assert.deepStrictEqual(await resets.all(), {}, "b6p dropped its claim");
});

test("a setup that died before its write, then a reset of the user's: the user's reset stays, nothing is claimed", async () => {
  const config = scratchConfig("[credential]\n\thelper = cache\n");
  const persistence = memoryPersistence();
  const died = makeService({ config, persistence, ...faultOn(anyWrite, "die") });
  await assert.rejects(died.service.setupGit(), /the process stopped here/);
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), [], "nothing was written");
  fs.appendFileSync(config.file, '[credential "https://gateway.bluestep.net"]\n\thelper =\n');
  const next = makeService({ config, persistence });
  const result = await next.service.removeGit();
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), [""], "the user's reset stays");
  assert.deepStrictEqual(result, { removed: [], keptResets: [] }, "the file shows the pair was never written");
  assert.deepStrictEqual(await next.resets.all(), {});
});

test("several reset-then-b6p pairs under one key: b6p's helpers go, every reset stays, reported", async () => {
  const pair = `\thelper =\n\thelper = ${GitCredential.DEFAULT_HELPER}\n`;
  const config = scratchConfig(`[credential "https://gateway.bluestep.net"]\n${pair}${pair}`);
  const { service, resets } = makeService({ config });
  await resets.put(config.file, GW_KEY, { state: "installed", helper: GitCredential.DEFAULT_HELPER });
  const result = await service.removeGit();
  assert.deepStrictEqual(result.keptResets, [
    { url: "https://gateway.bluestep.net", file: config.file, reason: "shared-key" },
  ]);
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), ["", ""], "only inert resets are left");
});

test("two setups at once, in one process, write one pair and one record", async () => {
  const config = scratchConfig("[credential]\n\thelper = cache\n");
  const persistence = memoryPersistence();
  const { service, resets } = makeService({ config, persistence });
  const other = makeService({ config, persistence });
  await Promise.all([service.setupGit(), service.setupGit(), other.service.setupGit()]);
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), ["", GitCredential.DEFAULT_HELPER]);
  assert.deepStrictEqual(await resets.all(), {
    [config.file]: { [GW_KEY]: { state: "installed", helper: GitCredential.DEFAULT_HELPER } },
  });
  await Promise.all([service.removeGit(), other.service.setupGit()]);
  const values = gitGetAll(config.env, GW_KEY);
  assert.ok(
    values.length === 0 || (values.length === 2 && values[0] === "" && values[1] === GitCredential.DEFAULT_HELPER),
    values.join("|")
  );
});

/** A child process running `body` (with `c` the compiled core) once the clock reaches `at`. */
function childAt(at, body, env = process.env) {
  const dist = path.join(__dirname, "..", "dist", "index.js");
  const code =
    `const c = require(${JSON.stringify(dist)});` +
    `setTimeout(() => (async () => { ${body} })().catch((e) => { console.error(e); process.exit(1); }), ${at} - Date.now());`;
  return new Promise((resolve, reject) => {
    const proc = require("node:child_process").spawn(process.execPath, ["-e", code], { stdio: "inherit", env });
    proc.on("exit", (status) => (status === 0 ? resolve() : reject(new Error(`child exited ${status}`))));
  });
}

test("two processes writing different keys of the shared state at once lose none of them", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "persist-"));
  const at = Date.now() + 700;
  const writes = (prefix) =>
    `const p = new c.SharedFilePersistence(${JSON.stringify(dir)});` +
    `for (let i = 0; i < 40; i++) await p.set("${prefix}" + i, i);`;
  await Promise.all([childAt(at, writes("a")), childAt(at, writes("b"))]);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  const missing = [];
  for (const prefix of ["a", "b"]) {
    for (let i = 0; i < 40; i++) {
      if (state[prefix + i] !== i) {
        missing.push(prefix + i);
      }
    }
  }
  assert.deepStrictEqual(missing, [], "every write of each process survives the other's");
});

test("two processes setting up git at once write one pair and one record", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "persist-"));
  const config = scratchConfig("[credential]\n\thelper = cache\n");
  const at = Date.now() + 700;
  const body =
    `const p = new c.SharedFilePersistence(${JSON.stringify(dir)});` +
    `const s = new c.GitCredentialService({ logger: console, token: { token: async () => undefined },` +
    ` gatewayUrl: async () => ${JSON.stringify(GATEWAY)}, hosts: new c.GitCredentialHosts(p),` +
    ` resets: new c.GitCredentialResets(p), gitConfig: c.gitConfigRunner(process.env) });` +
    `for (let i = 0; i < 3; i++) { await s.setupGit(); }`;
  await Promise.all([childAt(at, body, config.env), childAt(at, body, config.env), childAt(at, body, config.env)]);
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), ["", GitCredential.DEFAULT_HELPER]);
  const resets = await new GitCredentialResets(new SharedFilePersistence(dir)).all();
  assert.deepStrictEqual(
    Object.values(resets).map((keys) => Object.keys(keys)),
    [[GW_KEY]]
  );
});

test("config paths compare as git reports them on Windows: either slash, any case", () => {
  const { configPathKey } = core;
  assert.strictEqual(
    configPathKey("C:\\Users\\Example\\.gitconfig", "win32"),
    configPathKey("c:/users/example/.gitconfig", "win32")
  );
  assert.strictEqual(
    configPathKey(path.win32.join("C:\\Users\\Example", ".config", "git", "config"), "win32"),
    configPathKey("C:/Users/Example/.config/git/config", "win32")
  );
  assert.notStrictEqual(configPathKey("/home/a/.gitconfig", "posix"), configPathKey("/home/A/.gitconfig", "posix"));
  assert.notStrictEqual(
    configPathKey("C:\\Users\\Example\\.gitconfig", "win32"),
    configPathKey("C:/Users/Other/.gitconfig", "win32")
  );
});

test("on Windows, a reset recorded under b6p's backslash path is still found under git's forward-slash one", async () => {
  // git for Windows reports its global config as C:/Users/…; b6p names it C:\Users\…. On this machine the scratch file
  // is named with forward slashes; b6p is handed the same name with backslashes, which git (as on Windows) accepts.
  const config = scratchConfig();
  const backslashed = config.file.replace(/\//g, "\\");
  const real = gitConfigRunner(config.env);
  const persistence = memoryPersistence();
  const resets = new GitCredentialResets(persistence);
  const service = new GitCredentialService({
    logger,
    token: { token: async () => TOKEN },
    gatewayUrl: async () => GATEWAY,
    hosts: new GitCredentialHosts(persistence),
    resets,
    gitConfig: {
      pathStyle: "win32",
      globalFile: () => backslashed,
      run: (args) =>
        real.run(
          args.map((a, i) => (args[i - 1] === "--file" ? a.replace(/\\/g, "/") : a)),
          { cwd: tmp }
        ),
      git: (args) => real.git(args, { cwd: tmp }),
      editFile: (file, edit) => real.editFile(file.replace(/\\/g, "/"), edit),
    },
  });
  await service.setupGit();
  assert.deepStrictEqual(Object.keys(await resets.all()), [backslashed]);
  const result = await service.removeGit();
  assert.deepStrictEqual(result, { removed: ["https://gateway.bluestep.net"], keptResets: [] });
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), [], "b6p's reset went with its helper");
});

test("clearSettings and clearAll keep the record of b6p's resets, so a later removal still takes them out", async () => {
  for (const clear of ["clearSettings", "clearAll"]) {
    const config = scratchConfig("[credential]\n\thelper = cache\n");
    const saved = {};
    for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]) {
      saved[key] = process.env[key];
      process.env[key] = config.env[key];
    }
    const pub = {};
    const persistence = {
      get: async (k) => pub[k],
      set: async (k, v) => {
        pub[k] = JSON.parse(JSON.stringify(v));
      },
      delete: async (k) => {
        delete pub[k];
      },
      getSecret: async () => undefined,
      setSecret: async () => {},
      deleteSecret: async () => {},
      clearPublic: async () => {
        for (const k of Object.keys(pub)) delete pub[k];
      },
      clearSecrets: async () => {},
    };
    const prompt = {
      inputBox: async () => undefined,
      confirm: async () => undefined,
      info: noop,
      popup: async () => {},
    };
    const b6p = new core.B6PCore({
      fs: new core.MockFileSystem(),
      persistence,
      prompt: { ...prompt, warn: noop, error: noop },
      logger,
      progress: { withProgress: async (tasks) => Promise.all(tasks.map((t) => t.execute())) },
    });
    try {
      await b6p.gitCredential.setupGit();
      await b6p.setConfig("debugMode", true).catch(() => undefined);
      await b6p[clear]();
      assert.ok(pub[PublicKeys.GIT_CREDENTIAL_RESETS], `${clear} kept the record`);
      const result = await b6p.gitCredential.removeGit();
      assert.deepStrictEqual(result, { removed: ["https://gateway.bluestep.net"], keptResets: [] }, clear);
      assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), [], `${clear}: no reset of b6p's left behind`);
      assert.deepStrictEqual(gitGetAll(config.env, "credential.helper"), ["cache"]);
    } finally {
      b6p.dispose();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});

// ── the host list across instances and processes ──────────────────────

test("two host stores over the same directory lose nothing and resurrect nothing", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "persist-"));
  const a = new GitCredentialHosts(new SharedFilePersistence(dir));
  const b = new GitCredentialHosts(new SharedFilePersistence(dir));
  await Promise.all([a.record("https://one.bluestep.net/"), b.record("https://two.bluestep.net/")]);
  assert.deepStrictEqual(await a.hosts(), ["one.bluestep.net", "two.bluestep.net"]);
  const [forgot] = await Promise.all([a.forget("one.bluestep.net"), b.record("https://three.bluestep.net/")]);
  assert.strictEqual(forgot, true);
  assert.deepStrictEqual(await b.hosts(), ["three.bluestep.net", "two.bluestep.net"], "the forgotten host stays gone");
});

test("two processes recording at once lose nothing; a held lock times out", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "persist-"));
  const dist = path.join(__dirname, "..", "dist", "index.js");
  const child = (prefix) =>
    new Promise((resolve, reject) => {
      const code =
        `const c = require(${JSON.stringify(dist)});` +
        `const h = new c.GitCredentialHosts(new c.SharedFilePersistence(${JSON.stringify(dir)}));` +
        `(async () => { for (let i = 0; i < 12; i++) await h.record("https://${prefix}" + i + ".bluestep.net/"); })()` +
        `.catch((e) => { console.error(e); process.exit(1); });`;
      const proc = require("node:child_process").spawn(process.execPath, ["-e", code], { stdio: "inherit" });
      proc.on("exit", (status) => (status === 0 ? resolve() : reject(new Error(`child exited ${status}`))));
    });
  await Promise.all([child("a"), child("b")]);
  const hosts = await new GitCredentialHosts(new SharedFilePersistence(dir)).hosts();
  assert.strictEqual(hosts.length, 24, hosts.join(","));

  const lock = path.join(dir, `${PublicKeys.GIT_CREDENTIAL_HOSTS.replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`);
  fs.writeFileSync(lock, lockStamp({ pid: deadPid() }));
  const late = new GitCredentialHosts(new SharedFilePersistence(dir));
  // A dead holder's lock waits for a person; the record is then made.
  fs.unlinkSync(lock);
  assert.strictEqual(await late.record("https://late.bluestep.net/"), true);
  assert.ok(!fs.existsSync(lock), "released after use");

  const { withFileLock } = require("../dist/persistence/fileLock.js");
  fs.writeFileSync(lock, "held");
  await assert.rejects(
    withFileLock(lock, async () => "never", { timeoutMs: 100 }),
    /Timed out/
  );
  fs.unlinkSync(lock);
});

/**
 * Patch `fs/promises` methods for the length of `body` (the lock calls them through the module object, so a patch
 * there is seen), restoring them after.
 */
async function withPatchedFs(patches, body) {
  const fsp = require("node:fs/promises");
  const saved = {};
  for (const [name, patch] of Object.entries(patches)) {
    saved[name] = fsp[name];
    const original = fsp[name].bind(fsp);
    fsp[name] = (...args) => patch(original, ...args);
  }
  try {
    return await body();
  } finally {
    Object.assign(fsp, saved);
  }
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `body` with `require("node:fs")` functions patched (each patch gets the original first). */
async function withPatchedFsSync(patches, body) {
  const fsSync = require("node:fs");
  const saved = {};
  for (const [name, patch] of Object.entries(patches)) {
    saved[name] = fsSync[name];
    const original = fsSync[name].bind(fsSync);
    fsSync[name] = (...args) => patch(original, ...args);
  }
  try {
    return await body();
  } finally {
    Object.assign(fsSync, saved);
  }
}

test("creating the lock: a lasting refusal fails at once on POSIX; on Windows a sharing refusal is retried", async () => {
  const { withFileLock, FILE_LOCK_DEFAULTS } = require("../dist/persistence/fileLock.js");
  assert.strictEqual(FILE_LOCK_DEFAULTS.timeoutMs, 10_000);
  const dir = fs.mkdtempSync(path.join(tmp, "lock-"));
  const lock = path.join(dir, "state.lock");
  let attempts = 0;
  const refuse = (code) => (original, file, ...rest) => {
    if (String(file) !== lock) {
      return original(file, ...rest);
    }
    attempts++;
    throw Object.assign(new Error(`${code}: refused`), { code });
  };
  const posix = process.platform !== "win32";
  for (const code of ["EPERM", "EACCES", "EBUSY", "EROFS", "ENOSPC", "EDQUOT"]) {
    attempts = 0;
    const started = Date.now();
    const error = await withPatchedFsSync({ openSync: refuse(code) }, () =>
      withFileLock(lock, async () => "never", { timeoutMs: 2000, retryMs: 25 }).then(
        () => null,
        (e) => e
      )
    );
    const waited = Date.now() - started;
    assert.ok(error && error.message.includes(code), `${code}: ${error && error.message}`);
    if (posix || !["EPERM", "EACCES", "EBUSY"].includes(code)) {
      assert.match(error.message, /could not be created/);
      assert.ok(waited < 500 && attempts === 1, `${code}: ${attempts} attempts over ${waited} ms`);
    } else {
      assert.match(error.message, /Timed out/);
      assert.ok(waited >= 1900 && attempts <= 2000 / 25 + 3, `${code}: ${attempts} attempts over ${waited} ms`);
    }
  }
  attempts = 0;
  // A dead holder's lock that cannot be moved or removed: the same, rather than a loop with no end.
  fs.writeFileSync(lock, lockStamp({ pid: deadPid() }));
  attempts = 0;
  const started = Date.now();
  const refuseAsync = (code) => async () => {
    attempts++;
    throw Object.assign(new Error(`${code}: refused`), { code });
  };
  const outcome = await withPatchedFs({ unlink: refuseAsync("EPERM"), rename: refuseAsync("EPERM") }, () =>
    Promise.race([
      withFileLock(lock, async () => "never", { timeoutMs: 300, retryMs: 25 }).then(
        () => "acquired",
        (e) => e.message
      ),
      sleepMs(3000).then(() => "still trying"),
    ])
  );
  assert.match(outcome, /Timed out/);
  assert.ok(Date.now() - started >= 280);
  assert.ok(attempts <= 300 / 25 + 3, `${attempts} attempts`);
  fs.unlinkSync(lock);
});

// ── round 4: scopes, git's file, locks, the record, the git floor ─────

/** A scratch repository (with `remote`, when given, as origin) in `env`'s git config. */
function scratchRepo(env, remote) {
  const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  execFileSync("git", ["init", "-q", repo], { env });
  if (remote) {
    execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { env });
  }
  return repo;
}

test("status reads the config in effect where it runs: a repository's local store makes it not configured there", async () => {
  const config = scratchConfig();
  const { service } = makeService({ config });
  await service.setupGit();
  const repo = scratchRepo(config.env);
  execFileSync("git", ["-C", repo, "config", "--local", "credential.helper", "store"], { env: config.env });
  const here = await service.setupStatus({ cwd: repo });
  assert.strictEqual(here.hosts[0].configured, false, "git in that clone asks store after b6p");
  assert.deepStrictEqual(here.hosts[0].alsoAsked, ["store"]);
  assert.deepStrictEqual(here.hosts[0].others, [
    { key: "credential.helper", value: "store", file: path.join(repo, ".git", "config") },
  ]);
  assert.strictEqual(here.scope, "global+here");
  const outside = await service.setupStatus();
  assert.strictEqual(outside.configured, true);
  assert.strictEqual(outside.scope, "global", "a status outside any repository says it covers no repository's config");
  // Setup cannot change a repository's config, so it reports the clone and does not append again and again.
  const setup = await service.setupGit({ cwd: repo });
  assert.deepStrictEqual(setup.alreadyConfigured, ["gateway.bluestep.net"]);
  assert.strictEqual(setup.hosts[0].configured, false);
  assert.strictEqual(setup.scope, "global+here");
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), ["", GitCredential.DEFAULT_HELPER]);
});

test("status counts helpers from the command line (GIT_CONFIG_COUNT), which git reads last", async () => {
  const config = scratchConfig();
  await makeService({ config }).service.setupGit();
  const env = {
    ...config.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "store",
  };
  const status = await makeService({ config: { ...config, env } }).service.setupStatus();
  assert.strictEqual(status.hosts[0].configured, false);
  assert.deepStrictEqual(status.hosts[0].others, [{ key: "credential.helper", value: "store", file: null }]);
});

test("an includeIf after b6p's pair may add a helper in another repository: not configured, and setup repairs it", async () => {
  const config = scratchConfig();
  const { service } = makeService({ config });
  await service.setupGit();
  fs.appendFileSync(config.file, '[includeIf "gitdir:~/work/"]\n\tpath = work.gitconfig\n');
  const status = await service.setupStatus();
  assert.strictEqual(status.hosts[0].configured, false);
  assert.deepStrictEqual(status.hosts[0].alsoAsked, [], "it is not a helper itself");
  assert.deepStrictEqual(status.hosts[0].others, [
    { key: "includeif.gitdir:~/work/.path", value: "work.gitconfig", file: config.file },
  ]);
  const repaired = await service.setupGit();
  assert.deepStrictEqual(repaired.added, ["gateway.bluestep.net"]);
  assert.strictEqual(repaired.hosts[0].configured, true, "b6p's pair now comes after the include");
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), ["", GitCredential.DEFAULT_HELPER]);
});

test("cloneStatus: whether git in one clone asks b6p alone for its remote's host; null off the list", async () => {
  const config = scratchConfig();
  const { service } = makeService({ config });
  await service.setupGit();
  const kb = scratchRepo(config.env, "https://someone@gateway.bluestep.net/api/v1/git/kb.git");
  assert.deepStrictEqual(await service.cloneStatus(kb), {
    host: "gateway.bluestep.net",
    source: "gateway",
    configured: true,
    alsoAsked: [],
    others: [],
  });
  execFileSync("git", ["-C", kb, "config", "--local", "credential.helper", "store"], { env: config.env });
  const status = await service.cloneStatus(kb);
  assert.strictEqual(status.configured, false);
  assert.deepStrictEqual(status.alsoAsked, ["store"]);
  assert.ok(!JSON.stringify(status).includes("api/v1"), "the remote's URL is never in the result");
  assert.strictEqual(await service.cloneStatus(scratchRepo(config.env, "https://github.com/x/y.git")), null);
  assert.strictEqual(await service.cloneStatus(kb, { remote: "upstream" }), null);
  assert.strictEqual(await service.cloneStatus(scratchRepo(config.env)), null);
  await assert.rejects(service.cloneStatus(kb, { remote: "a b" }), Err.GitCredentialSetupError);
});

test('an empty subsection, [credential ""], applies to every host: in status, in removal and in real git', async () => {
  const config = scratchConfig();
  const { service } = makeService({ config });
  await service.setupGit();
  fs.appendFileSync(config.file, '[credential ""]\n\thelper = store\n');
  const status = await service.setupStatus();
  assert.strictEqual(status.hosts[0].configured, false);
  assert.deepStrictEqual(status.hosts[0].alsoAsked, ["store"]);
  // git asks it: a helper there runs for the gateway's request.
  const marks = path.join(tmp, `marks-${++configN}`);
  const asking = scratchConfig(`[credential ""]\n\thelper = "!f() { echo x >> '${marks}'; }; f"\n`);
  credential("fill", "protocol=https\nhost=gateway.bluestep.net\n\n", asking.env);
  assert.ok(fs.existsSync(marks), "git 2.53 asks a helper under an empty subsection");
  // b6p's own entry there is b6p's to remove.
  const mine = scratchConfig(`[credential ""]\n\thelper = ${GitCredential.DEFAULT_HELPER}\n`);
  const removed = await makeService({ config: mine }).service.removeGit();
  assert.deepStrictEqual(removed.removed, [""]);
  assert.deepStrictEqual(entriesOf(mine.env, mine.file), []);
});

test("setup writes the file git itself says --global writes, not one worked out from HOME", async () => {
  if (process.platform === "win32") {
    return; // The stand-in git below is a shell script.
  }
  // Git for Windows takes its home from HOMEDRIVE and HOMEPATH, not HOME; a git that sees another home stands in.
  const scratch = scratchHome({});
  const gitsHome = fs.mkdtempSync(path.join(tmp, "gits-home-"));
  const bin = fs.mkdtempSync(path.join(tmp, "bin-"));
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\nHOME='${gitsHome}'; export HOME; unset XDG_CONFIG_HOME\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 }
  );
  const env = { ...scratch.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const { service } = makeService({ config: { env } });
  assert.deepStrictEqual((await service.setupGit()).added, ["gateway.bluestep.net"]);
  assert.deepStrictEqual((await service.setupGit()).added, [], "the second run finds the first's pair");
  const written = path.join(gitsHome, ".gitconfig");
  assert.deepStrictEqual(entriesOf(env, written), [`${GW_KEY}\n`, `${GW_KEY}\n${GitCredential.DEFAULT_HELPER}`]);
  assert.strictEqual(fs.existsSync(path.join(scratch.home, ".gitconfig")), false, "HOME's file is not git's");
  await service.removeGit();
  assert.deepStrictEqual(entriesOf(env, written), []);
});

test("git older than 2.27.0 is refused for status and removal, and older than 2.42.0 for setup", async () => {
  const at = (version) =>
    makeService({
      git: async (args, real) =>
        args[0] === "--version" ? { code: 0, stdout: `${version}\n`, stderr: "" } : real(args),
    }).service;
  const floor = (want) => (e) => e instanceof Err.GitCredentialSetupError && e.message.includes(want);
  for (const old of ["git version 2.26.2", "git version 1.9.5", "git version 2.26.9.windows.1"]) {
    await assert.rejects(at(old).setupStatus(), floor("2.27.0"), old);
    await assert.rejects(at(old).removeGit(), floor("2.27.0"), old);
    await assert.rejects(at(old).setupGit(), floor("2.42.0"), old);
  }
  for (const mid of ["git version 2.27.0", "git version 2.39.3 (Apple Git-146)", "git version 2.41.9"]) {
    assert.strictEqual((await at(mid).setupStatus()).configured, false, mid);
    await assert.rejects(at(mid).setupGit(), floor("2.42.0"), mid);
  }
  for (const ok of ["git version 2.42.0", "git version 2.45.1.windows.1", "git version 3.0"]) {
    assert.deepStrictEqual((await at(ok).setupGit()).added, ["gateway.bluestep.net"], ok);
  }
  await assert.rejects(at("not git").setupStatus(), Err.GitCredentialSetupError);
  const missing = makeService({ git: async () => ({ code: -1, stdout: "", stderr: "" }) }).service;
  await assert.rejects(
    missing.setupStatus(),
    (e) => e instanceof Err.GitCredentialSetupError && /installed/.test(e.message)
  );
});

test("clear keeps the record whole: a removal during a slow clear still finds b6p's pair", async () => {
  const config = scratchConfig("[credential]\n\thelper = cache\n");
  const saved = {};
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]) {
    saved[key] = process.env[key];
    process.env[key] = config.env[key];
  }
  const pub = {};
  const persistence = {
    get: async (k) => pub[k],
    set: async (k, v) => {
      pub[k] = JSON.parse(JSON.stringify(v));
    },
    delete: async (k) => {
      delete pub[k];
    },
    getSecret: async () => undefined,
    setSecret: async () => {},
    deleteSecret: async () => {},
    clearPublic: async () => {
      for (const k of Object.keys(pub)) delete pub[k];
      await sleepMs(200); // The record is missing until core writes it back.
    },
    clearSecrets: async () => {},
  };
  const b6p = new core.B6PCore({
    fs: new core.MockFileSystem(),
    persistence,
    prompt: {
      inputBox: async () => undefined,
      confirm: async () => undefined,
      info: noop,
      popup: async () => {},
      warn: noop,
      error: noop,
    },
    logger,
    progress: { withProgress: async (tasks) => Promise.all(tasks.map((t) => t.execute())) },
  });
  try {
    await b6p.gitCredential.setupGit();
    const clearing = b6p.clearSettings();
    await sleepMs(50);
    const result = await b6p.gitCredential.removeGit();
    await clearing;
    assert.deepStrictEqual(result, { removed: ["https://gateway.bluestep.net"], keptResets: [] });
    assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), [], "b6p's reset went with its helper");
  } finally {
    b6p.dispose();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("SharedFilePersistence clears all public state but the kept keys in one write", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "persist-"));
  const p = new SharedFilePersistence(dir);
  await p.set("other", 1);
  await p.set(PublicKeys.GIT_CREDENTIAL_RESETS, { f: { k: { state: "installed", helper: "h" } } });
  const fsp = require("node:fs/promises");
  let writes = 0;
  await withPatchedFs(
    {
      rename: (original, from, to) => {
        if (String(to) === path.join(dir, "state.json")) {
          writes++;
        }
        return original(from, to);
      },
    },
    () => p.clearPublicExcept([PublicKeys.GIT_CREDENTIAL_RESETS, "absent"])
  );
  assert.ok(fsp);
  assert.strictEqual(writes, 1);
  const fresh = new SharedFilePersistence(dir);
  assert.strictEqual(await fresh.get("other"), undefined);
  assert.deepStrictEqual(await fresh.get(PublicKeys.GIT_CREDENTIAL_RESETS), {
    f: { k: { state: "installed", helper: "h" } },
  });
  assert.strictEqual(await fresh.get("absent"), undefined);
});

test("b6p reads a config file as git 2.53 does, and its pair edits leave git reading exactly what they promise", () => {
  const { parseConfigFile, appendPair, pairsIn, removePair } = core;
  const listed = (text) => {
    const file = path.join(tmp, `parse-${++configN}.gitconfig`);
    fs.writeFileSync(file, text);
    const run = spawnSync("git", ["config", "--file", file, "--null", "--list"], { encoding: "utf8" });
    if (run.status !== 0) {
      return null;
    }
    return run.stdout
      .split("\0")
      .slice(0, -1)
      .map((record) => {
        const at = record.indexOf("\n");
        return at === -1 ? [record, null] : [record.slice(0, at), record.slice(at + 1)];
      });
  };
  const ours = (text) => {
    const entries = parseConfigFile(text);
    return entries && entries.map((e) => [e.key, e.value]);
  };
  const corpus = [
    "",
    "[credential]\n\thelper = cache\n",
    "\uFEFF[Credential]\r\n\tHelper = cache\r\n",
    '[credential "https://Gateway.Bluestep.net"]\n\thelper =\n\thelper = "!b6p auth git-credential"\n',
    '[credential ""]\n\thelper = store\n',
    "[credential.https://x]\n\thelper = a\n",
    '[credential "a\\"b\\\\c"]\n\thelper = x ; comment\n\thelper = "quoted ; not comment" # c\n',
    "[a] b = 1\n[c]d\n\te=  spaced  value  \n",
    "[a]\n\tb = one \\\n two\n\tc = tab\\there\\nnl\n",
    "[a]\n# comment\n; other\n\n\tb = 1",
    "[a]\n\tb = \\q\n",
    '[a]\n\tb = "open\n',
    "[a\n",
    "b = 1\n",
    "[a]\n\tb ;c\n",
    '[a "x"y]\n',
    "[a]\n\t1b = x\n",
    "[a]\n\tb-c = x\n\tb_c = y\n",
    '[a "x"] b = 1\n',
    "[a]\n\tb\n\tc =\n",
    "[a]\n\tb = x\\",
    '[a]\r\n\tb = "x\r\n"\n',
    "[a]\n\tb = x\r\n\tc = y\r",
    "[a] [b]\n\tc = 1\n",
    "[a]\n\tb = x\fy\v\n",
  ];
  for (const text of corpus) {
    assert.deepStrictEqual(ours(text), listed(text), JSON.stringify(text));
  }
  const helper = '!"/opt/b 6p/b6p" auth git-credential\t; # "x" \\';
  for (const text of ["[credential]\n\thelper = cache", "[credential]\r\n\thelper = cache\r\n", ""]) {
    const appended = appendPair(text, 'https://we"ird\\host', helper);
    const key = 'credential.https://we"ird\\host.helper';
    assert.deepStrictEqual(listed(appended).slice(-2), [
      [key, ""],
      [key, helper],
    ]);
    const parsed = parseConfigFile(appended);
    const pairs = pairsIn(parsed, key, helper);
    assert.strictEqual(pairs.length, 1);
    assert.deepStrictEqual(listed(removePair(appended, parsed, pairs[0])), listed(text), JSON.stringify(text));
  }
  // In a section of the user's, only the two lines go; the header and the user's entries stay.
  const shared = '[credential "https://h"]\n\thelper = mine\n\thelper =\n\thelper = b6p\n\tusername = u\n';
  const parsed = parseConfigFile(shared);
  assert.strictEqual(
    removePair(shared, parsed, pairsIn(parsed, "credential.https://h.helper", "b6p")[0]),
    '[credential "https://h"]\n\thelper = mine\n\tusername = u\n'
  );
});

test("a release refused once (EPERM) is retried, so the next writer gets the lock at once", async () => {
  const { withFileLock } = require("../dist/persistence/fileLock.js");
  const lock = path.join(fs.mkdtempSync(path.join(tmp, "lock-")), "state.lock");
  let refused = 0;
  // The first call that would take the lockfile away (removing or moving it) is refused, as Windows does while
  // another process has the file open.
  const refuseOnce = async (original, target, ...rest) => {
    if (path.resolve(String(target)) === lock && refused === 0) {
      refused++;
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    }
    return original(target, ...rest);
  };
  await withPatchedFs({ unlink: refuseOnce, rename: refuseOnce }, () => withFileLock(lock, async () => "first"));
  assert.strictEqual(refused, 1);
  assert.ok(!fs.existsSync(lock), "released after the retry");
  assert.strictEqual(await withFileLock(lock, async () => "next", { timeoutMs: 1000 }), "next");
});

// ── round 5: bytes, modes, usernames, symlinks, continuations, pair counts, relative paths ──

/** `git config --list --show-origin -z` of one file, as bytes. */
const listedBytes = (file) => execFileSync("git", ["config", "--file", file, "--list", "--show-origin", "-z"]);

test("a config file that is not UTF-8 keeps every byte: setup only adds b6p's entries, removal restores the file exactly", async () => {
  const original = Buffer.concat([
    Buffer.from("[user]\n\tname = Jos"),
    Buffer.from([0xe9]), // cp1252 é
    Buffer.from("\n# raw bytes "),
    Buffer.from(Array.from({ length: 128 }, (_, i) => 0x80 + i).filter((b) => b !== 0x0a)),
    Buffer.from('\n[alias]\n\tx = "bad '),
    Buffer.from([0xc3, 0x28, 0xff, 0xfe]), // invalid UTF-8
    Buffer.from('" ; comment '),
    Buffer.from([0xa0, 0xe9]),
    Buffer.from("\n[credential]\n\thelper = cache\n"),
  ]);
  const config = scratchConfig();
  fs.writeFileSync(config.file, original);
  const before = listedBytes(config.file);
  const { service } = makeService({ config });
  const helper = "!/opt/b6p é/b6p auth git-credential";
  await service.setupGit({ helper });
  const after = listedBytes(config.file);
  assert.ok(after.subarray(0, before.length).equals(before), "every entry git read before reads the same");
  const added = after.subarray(before.length).toString("utf8").split("\0");
  assert.deepStrictEqual(added.slice(1, 2).concat(added.slice(3, 4)), [`${GW_KEY}\n`, `${GW_KEY}\n${helper}`]);
  assert.strictEqual((await service.setupStatus({ helper })).configured, true, "the non-ASCII helper reads back");
  await service.removeGit({ helpers: [helper] });
  assert.ok(fs.readFileSync(config.file).equals(original), "byte-identical after removal");
});

test("the lockfile is never more readable than the config file: a 0600 file under umask 022", async () => {
  if (process.platform === "win32") {
    return;
  }
  const config = scratchConfig("[credential]\n\thelper = cache\n");
  fs.chmodSync(config.file, 0o600);
  const modes = [];
  const saved = process.umask(0o022);
  try {
    const { service } = makeService({
      config,
      edit: (file, edit, real) =>
        real(file, (text) => {
          modes.push(fs.statSync(`${file}.lock`).mode & 0o777);
          return edit(text);
        }),
    });
    await service.setupGit();
  } finally {
    process.umask(saved);
  }
  assert.deepStrictEqual(modes, [0o600], "the lock had the file's mode before anything was written to it");
  assert.strictEqual(fs.statSync(config.file).mode & 0o777, 0o600);
});

test("a credential.username that changes partway through the config: a partial user@ helper may be asked", async () => {
  // git's partial-URL fallback compares the username config has set so far.
  const marks = path.join(tmp, `marks-${++configN}`);
  const mark = `"!f() { echo x >> '${marks}'; }; f"`;
  const scenario = (helper) =>
    "[credential]\n\tusername = someone\n" +
    `[credential "someone@gateway.bluestep.net"]\n\thelper = ${helper}\n` +
    "[credential]\n\tusername = b6p\n";
  credential("fill", "protocol=https\nhost=gateway.bluestep.net\n\n", scratchConfig(scenario(mark)).env);
  assert.ok(fs.existsSync(marks), "real git asks the someone@ helper");
  fs.rmSync(marks);
  const without = `[credential "someone@gateway.bluestep.net"]\n\thelper = ${mark}\n`;
  credential("fill", "protocol=https\nhost=gateway.bluestep.net\n\n", scratchConfig(without).env);
  assert.ok(!fs.existsSync(marks), "and only because of the username entry");

  const config = scratchConfig();
  const { service } = makeService({ config });
  await service.setupGit();
  fs.appendFileSync(config.file, scenario("store"));
  const status = await service.setupStatus();
  assert.strictEqual(status.hosts[0].configured, false);
  assert.deepStrictEqual(status.hosts[0].alsoAsked, ["store"]);
});

test("a symlinked global config is edited at its target, a missing one included; the link stays a link", async () => {
  if (process.platform === "win32") {
    return;
  }
  const scratch = scratchHome({ "dotfiles/README": "" });
  const link = path.join(scratch.home, ".gitconfig");
  fs.symlinkSync("dotfiles/gitconfig", link);
  const { service } = makeService({ config: { env: scratch.env } });
  assert.deepStrictEqual((await service.setupGit()).added, ["gateway.bluestep.net"]);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "still a link");
  const target = path.join(scratch.home, "dotfiles", "gitconfig");
  assert.deepStrictEqual(entriesOf(scratch.env, target), [`${GW_KEY}\n`, `${GW_KEY}\n${GitCredential.DEFAULT_HELPER}`]);
  assert.deepStrictEqual((await service.setupGit()).added, []);
  await service.removeGit();
  assert.deepStrictEqual(entriesOf(scratch.env, target), []);
  assert.ok(fs.lstatSync(link).isSymbolicLink());

  // A target whose directory is missing: git cannot lock it, and neither does b6p; the link is left alone.
  const other = scratchHome({});
  const dangling = path.join(other.home, ".gitconfig");
  fs.symlinkSync("missing/gitconfig", dangling);
  const gitSays = spawnSync("git", ["config", "--global", "x.y", "z"], { env: other.env, encoding: "utf8" });
  assert.notStrictEqual(gitSays.status, 0, "git refuses too");
  await assert.rejects(makeService({ config: { env: other.env } }).service.setupGit(), Err.GitCredentialSetupError);
  assert.ok(fs.lstatSync(dangling).isSymbolicLink());
  assert.ok(!fs.existsSync(path.join(other.home, "missing")));
});

test("a file whose last value continues onto the next line keeps that value: setup ends the continuation first", async () => {
  for (const ending of ["", "\n", "\r\n"]) {
    const config = scratchConfig(`[credential "https://gateway.bluestep.net"]\n\tusername = b6p\\${ending}`);
    const username = "credential.https://gateway.bluestep.net.username";
    assert.deepStrictEqual(gitGetAll(config.env, username), ["b6p"]);
    const { service } = makeService({ config });
    const result = await service.setupGit();
    assert.strictEqual(result.hosts[0].configured, true, JSON.stringify(ending));
    assert.deepStrictEqual(gitGetAll(config.env, username), ["b6p"], JSON.stringify(ending));
    assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), ["", GitCredential.DEFAULT_HELPER]);
    await service.removeGit();
    assert.deepStrictEqual(gitGetAll(config.env, username), ["b6p"]);
    assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), []);
  }
});

test("pairs are counted as git sees them: a reset on its header's line counts, and two pairs keep both resets", async () => {
  const { service, resets, config } = makeService({
    config: scratchConfig(
      `[credential "https://gateway.bluestep.net"] helper =\n\thelper = ${GitCredential.DEFAULT_HELPER}\n` +
        `[credential "https://gateway.bluestep.net"]\n\thelper =\n\thelper = ${GitCredential.DEFAULT_HELPER}\n`
    ),
  });
  await resets.put(config.file, GW_KEY, { state: "installed", helper: GitCredential.DEFAULT_HELPER });
  const result = await service.removeGit();
  assert.deepStrictEqual(result.keptResets, [
    { url: "https://gateway.bluestep.net", file: config.file, reason: "shared-key" },
  ]);
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), ["", ""], "both resets stay; only b6p's helpers went");

  // One pair, its reset on the header's line: b6p's, but not lines it can cut out alone; kept and reported.
  const one = makeService({
    config: scratchConfig(
      `[credential "https://gateway.bluestep.net"] helper =\n\thelper = ${GitCredential.DEFAULT_HELPER}\n`
    ),
  });
  await one.resets.put(one.config.file, GW_KEY, { state: "installed", helper: GitCredential.DEFAULT_HELPER });
  const kept = await one.service.removeGit();
  assert.deepStrictEqual(kept.keptResets, [
    { url: "https://gateway.bluestep.net", file: one.config.file, reason: "unconfirmed" },
  ]);
  assert.deepStrictEqual(gitGetAll(one.config.env, GW_KEY), [""]);
});

test("a relative GIT_CONFIG_GLOBAL names one file, the process directory's, for reads, edits and records alike", async () => {
  const config = scratchConfig("[credential]\n\thelper = cache\n");
  const relative = path.relative(process.cwd(), config.file);
  assert.ok(!path.isAbsolute(relative));
  const env = { ...config.env, GIT_CONFIG_GLOBAL: relative };
  const { service, resets } = makeService({ config: { ...config, env } }); // git runs in tmp, not the process's directory
  assert.deepStrictEqual((await service.setupGit()).added, ["gateway.bluestep.net"]);
  assert.deepStrictEqual(Object.keys(await resets.all()), [config.file]);
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), ["", GitCredential.DEFAULT_HELPER]);
  assert.strictEqual((await service.setupStatus()).configured, true);
  const repo = scratchRepo(config.env);
  assert.strictEqual(
    (await service.setupStatus({ cwd: repo })).configured,
    true,
    "the same file from another directory"
  );
  assert.deepStrictEqual(await service.removeGit(), { removed: ["https://gateway.bluestep.net"], keptResets: [] });
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), []);
});

// ── the lock, git-style: no time-based takeover ───────────────────────

/** A process's start time as the lock records it (Linux: /proc stat field 22; macOS: ps lstart), or null. */
function startOf(pid) {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }
    if (process.platform === "win32") {
      return null;
    }
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" })
      .trim()
      .replace(/\s+/g, "_");
  } catch {
    return null;
  }
}
/** This process's PID namespace as the lock records it. */
function lockSelf() {
  return { ns: process.platform === "linux" ? fs.readlinkSync("/proc/self/ns/pid") : "-" };
}
/** A lock stamp, in the format the lock writes. */
function lockStamp({ pid, host = os.hostname(), start = "-", ns = lockSelf().ns }) {
  return `b6p-lock pid=${pid} host=${host} start=${start} ns=${ns} token=0123456789abcdef01234567`;
}
/** The pid of a process that has just exited. */
function deadPid() {
  return Number(execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }));
}
const lockIn = () => path.join(fs.mkdtempSync(path.join(tmp, "lock-")), "state.lock");

test("the lock never has two holders, even when a holder's event loop is blocked longer than any staleness", async () => {
  // Round 4's heartbeat lock took a lock over once its heartbeat was 5 s old: a holder blocked that long had company.
  const dir = fs.mkdtempSync(path.join(tmp, "lock-"));
  const lock = path.join(dir, "state.lock");
  const log = path.join(dir, "log");
  const fileLock = path.join(__dirname, "..", "dist", "persistence", "fileLock.js");
  const child = (name, delay, body) =>
    new Promise((resolve, reject) => {
      const code =
        `const { withFileLock } = require(${JSON.stringify(fileLock)}); const fs = require("fs");` +
        `const mark = (m) => fs.appendFileSync(${JSON.stringify(log)}, "${name} " + m + " " + Date.now() + "\\n");` +
        `setTimeout(() => withFileLock(${JSON.stringify(lock)}, async () => { mark("in"); ${body}; mark("out"); },` +
        ` { timeoutMs: 15000 }).catch((e) => { mark("gave-up"); }), ${delay});`;
      const proc = require("node:child_process").spawn(process.execPath, ["-e", code], { stdio: "inherit" });
      proc.on("exit", (status) => (status === 0 ? resolve() : reject(new Error(`${name} exited ${status}`))));
    });
  await Promise.all([child("A", 0, "const end = Date.now() + 6500; while (Date.now() < end) {}"), child("B", 400, "")]);
  const marks = fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split(" "));
  const at = (who, what) => Number((marks.find((m) => m[0] === who && m[1] === what) ?? [])[2]);
  assert.ok(at("A", "out") > 0 && at("B", "in") > 0, marks.join("|"));
  assert.ok(at("B", "in") >= at("A", "out"), "B entered only after A left");
  assert.ok(!fs.existsSync(lock));
});

test("a lock is never removed by another process: a dead holder, another host, a partial stamp, any age", async () => {
  const { withFileLock } = require("../dist/persistence/fileLock.js");
  const dead = deadPid();
  const kept = [
    lockStamp({ pid: dead }),
    `b6p-lock pid=${dead} host=${os.hostname()} token=0123456789abcdef01234567`,
    lockStamp({ pid: dead, host: "another-host" }),
    lockStamp({ pid: dead, ns: "pid:[1]" }),
    `b6p-lock pid=${dead} host=${os.hostname()}`,
    "",
    "12345 0 stale",
  ];
  if (process.platform !== "win32" && process.getuid && process.getuid() !== 0) {
    kept.push(lockStamp({ pid: 1, start: "1" })); // kill(1, 0) is EPERM for a user: alive, whatever its start time.
  }
  for (const stamp of kept) {
    const lock = lockIn();
    fs.writeFileSync(lock, stamp);
    const old = new Date(Date.now() - 86_400_000);
    fs.utimesSync(lock, old, old); // A day old: age never matters.
    await assert.rejects(
      withFileLock(lock, async () => "never", { timeoutMs: 150 }),
      /Timed out/,
      stamp
    );
    assert.strictEqual(fs.readFileSync(lock, "utf8"), stamp, stamp);
  }
});

// ── round 6: no takeover at all, pending releases, crash cleanup, directories, users, modes, git's errors ──

test("a dead holder's lock is never removed: the wait ends naming the lock, its holder, and what to do", async () => {
  const { withFileLock } = require("../dist/persistence/fileLock.js");
  const lock = lockIn();
  const dead = deadPid();
  const stamp = lockStamp({ pid: dead, start: "1" }); // Round 5 took this one over: same host and namespace, pid gone.
  fs.writeFileSync(lock, stamp);
  const error = await withFileLock(lock, async () => "never", { timeoutMs: 300 }).then(
    () => null,
    (e) => e
  );
  assert.ok(error, "not taken over");
  assert.ok(error.message.includes(`held by process ${dead} on ${os.hostname()}`), error.message);
  assert.ok(error.message.includes(`If no b6p or VS Code process is running, delete ${lock}.`), error.message);
  assert.strictEqual(fs.readFileSync(lock, "utf8"), stamp);
  // An empty lock (a process stopped between creating and writing it) says so.
  fs.writeFileSync(lock, "");
  await assert.rejects(
    withFileLock(lock, async () => "never", { timeoutMs: 100 }),
    /The lock is empty/
  );
});

test("a release refused every time stays pending, and this process removes that lock on its next acquisition", async () => {
  const { withFileLock } = require("../dist/persistence/fileLock.js");
  const lock = lockIn();
  const refuse = async (original, target, ...rest) => {
    if (path.resolve(String(target)) === lock) {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    }
    return original(target, ...rest);
  };
  await withPatchedFs({ unlink: refuse, rename: refuse }, () => withFileLock(lock, async () => "first"));
  assert.ok(fs.existsSync(lock), "left by the refused release");
  const started = Date.now();
  assert.strictEqual(await withFileLock(lock, async () => "next", { timeoutMs: 1000 }), "next");
  assert.ok(Date.now() - started < 500, "recovered at once, not after a wait");
  assert.ok(!fs.existsSync(lock));
});

test("a process stopped by SIGINT or SIGTERM removes its locks and git's config lock, and stops with that signal", async () => {
  if (process.platform === "win32") {
    return;
  }
  const dist = path.join(__dirname, "..", "dist", "index.js");
  const fileLock = path.join(__dirname, "..", "dist", "persistence", "fileLock.js");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const dir = fs.mkdtempSync(path.join(tmp, "sig-"));
    const lock = path.join(dir, "state.lock");
    const config = path.join(dir, "gitconfig");
    fs.writeFileSync(config, "[user]\n\tname = x\n");
    const ready = path.join(dir, "ready");
    const code =
      `const c = require(${JSON.stringify(dist)}); const fsp = require("fs/promises"); const fs = require("fs");` +
      `const { withFileLock } = require(${JSON.stringify(fileLock)});` +
      `setInterval(() => {}, 1000);` +
      `const rename = fsp.rename; fsp.rename = (a, b) => String(a).endsWith(".lock") ? new Promise(() => {}) : rename(a, b);` +
      `withFileLock(${JSON.stringify(lock)}, async () => {` +
      `  c.editConfigFile(${JSON.stringify(config)}, (t) => t + "[a]\\n\\tb = 1\\n");` +
      `  setTimeout(() => fs.writeFileSync(${JSON.stringify(ready)}, ""), 200);` +
      `  await new Promise(() => {});` +
      `});`;
    const proc = require("node:child_process").spawn(process.execPath, ["-e", code], { stdio: "inherit" });
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) {
      await sleepMs(50);
    }
    assert.ok(fs.existsSync(lock) && fs.existsSync(`${config}.lock`), `${signal}: both locks held`);
    const ended = new Promise((resolve) => proc.on("exit", (status, sig) => resolve({ status, sig })));
    proc.kill(signal);
    const { status, sig } = await ended;
    assert.strictEqual(sig, signal, `${signal}: stopped by the signal (status ${status})`);
    assert.ok(!fs.existsSync(lock), `${signal}: b6p's lock removed`);
    assert.ok(!fs.existsSync(`${config}.lock`), `${signal}: git's config lock removed`);
    assert.strictEqual(fs.readFileSync(config, "utf8"), "[user]\n\tname = x\n");
  }
});

/** A child holding `lock` inside withFileLock (after `prelude`), and a promise of its exit, once it is inside. */
async function childHolding(lock, prelude) {
  const fileLock = path.join(__dirname, "..", "dist", "persistence", "fileLock.js");
  const ready = `${lock}.ready`;
  const code =
    `const fs = require("fs"); const { withFileLock } = require(${JSON.stringify(fileLock)});` +
    `setInterval(() => {}, 1000); ${prelude}` +
    `withFileLock(${JSON.stringify(lock)}, async () => {` +
    `  fs.writeFileSync(${JSON.stringify(ready)}, "");` +
    `  await new Promise(() => {});` +
    `});`;
  const proc = require("node:child_process").spawn(process.execPath, ["-e", code], { stdio: "inherit" });
  const ended = new Promise((resolve) => proc.on("exit", (status, sig) => resolve({ status, sig })));
  for (let i = 0; i < 100 && !fs.existsSync(ready); i++) {
    await sleepMs(50);
  }
  assert.ok(fs.existsSync(lock), "the child holds the lock");
  return { proc, ended };
}

test("SIGINT with a host handler that keeps the process alive leaves the lock held: no second holder gets in", async () => {
  if (process.platform === "win32") {
    return;
  }
  const lock = path.join(fs.mkdtempSync(path.join(tmp, "sig-host-")), "state.lock");
  const { withFileLock } = require("../dist/persistence/fileLock.js");
  const { proc, ended } = await childHolding(lock, `process.on("SIGINT", () => {});`);
  try {
    proc.kill("SIGINT");
    await sleepMs(300);
    assert.ok(fs.existsSync(lock), "the lock is still there");
    let entered = false;
    await assert.rejects(
      withFileLock(lock, async () => (entered = true), { timeoutMs: 300 }),
      /Timed out waiting for the lock/
    );
    assert.ok(!entered, "no second holder");
    proc.kill("SIGTERM");
    assert.strictEqual((await ended).sig, "SIGTERM");
    assert.ok(!fs.existsSync(lock), "removed once the process does stop");
  } finally {
    proc.kill("SIGKILL");
  }
});

test("SIGINT with a host handler that calls process.exit removes the lock on the way out", async () => {
  if (process.platform === "win32") {
    return;
  }
  const lock = path.join(fs.mkdtempSync(path.join(tmp, "sig-exit-")), "state.lock");
  const { proc, ended } = await childHolding(lock, `process.on("SIGINT", () => process.exit(7));`);
  try {
    proc.kill("SIGINT");
    assert.strictEqual((await ended).status, 7, "the host's handler decided the exit");
    assert.ok(!fs.existsSync(lock));
  } finally {
    proc.kill("SIGKILL");
  }
});

/** Run `node -e code` with `args`; resolves { status, signal, stdout }. */
function nodeChild(code, args = []) {
  return new Promise((resolve) => {
    const proc = require("node:child_process").spawn(process.execPath, ["-e", code, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.on("exit", (status, signal) => resolve({ status, signal, stdout }));
  });
}

// A child starting `start` (with `F` the file to lock or edit) that stops on its own (exit or SIGINT) after `spins`
// turns of the event loop: at some point of the acquisition, however the threads run.
const stopAfterSpins = (requires, start, stop) =>
  `${requires} const F = process.argv[1]; const spins = Number(process.argv[2]); ${start};` +
  `let n = 0; const tick = () => { if (n++ >= spins) ${stop}; else setImmediate(tick); }; setImmediate(tick);`;

test("an exit or SIGINT at any moment of an acquisition leaves no lock: b6p's and git's config lock", async () => {
  const dist = path.join(__dirname, "..", "dist");
  const fileLock = `const { withFileLock } = require(${JSON.stringify(path.join(dist, "persistence", "fileLock.js"))});`;
  const runner = `const { editConfigFile } = require(${JSON.stringify(path.join(dist, "gitCredential", "GitConfigRunner.js"))});`;
  const cases = [
    ["b6p's lock, exit", fileLock, "withFileLock(F, () => new Promise(() => {})).catch(() => {})", "process.exit(0)", "l.lock"],
    ["git's lock, exit", runner, `editConfigFile(F, (t) => t + "[x]\\n").catch(() => {})`, "process.exit(0)", "config.lock"],
  ];
  if (process.platform !== "win32") {
    cases.push([
      "git's lock, SIGINT",
      runner,
      `editConfigFile(F, (t) => t + "[x]\\n").catch(() => {})`,
      `process.kill(process.pid, "SIGINT")`,
      "config.lock",
    ]);
  }
  for (const [name, requires, start, stop, left] of cases) {
    const leaks = [];
    for (let spins = 0; spins < 30; spins++) {
      const dir = fs.mkdtempSync(path.join(tmp, "gap-"));
      const target = path.join(dir, left === "l.lock" ? left : "config"); // b6p's lock itself, or git's config file
      await nodeChild(stopAfterSpins(requires, start, stop), [target, String(spins)]);
      if (fs.existsSync(path.join(dir, left))) {
        leaks.push(spins);
      }
    }
    assert.deepStrictEqual(leaks, [], `${name}: a lock left after stopping at spins ${leaks.join(", ")}`);
  }
});

test("exit cleanup leaves a lock whose content is no longer this acquisition's stamp, even on the same inode", async () => {
  const fileLock = path.join(__dirname, "..", "dist", "persistence", "fileLock.js");
  const lock = path.join(fs.mkdtempSync(path.join(tmp, "reuse-")), "state.lock");
  const other = "b6p-lock pid=1 host=elsewhere token=another";
  // The same inode now holding another acquisition's stamp, as a reused inode would.
  const code =
    `const fs = require("fs"); const { withFileLock } = require(${JSON.stringify(fileLock)});` +
    `withFileLock(${JSON.stringify(lock)}, async () => { fs.writeFileSync(${JSON.stringify(lock)}, ${JSON.stringify(other)});` +
    `  process.exit(0); });`;
  const { status } = await nodeChild(code);
  assert.strictEqual(status, 0);
  assert.strictEqual(fs.readFileSync(lock, "utf8"), other, "another process's lock is left alone");
});

test("a host's once or self-removing signal handler registered first gets to finish: b6p does not re-raise", async () => {
  if (process.platform === "win32") {
    return;
  }
  const fileLock = path.join(__dirname, "..", "dist", "persistence", "fileLock.js");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    for (const how of ["once", "removes itself"]) {
      const dir = fs.mkdtempSync(path.join(tmp, "sig-once-"));
      const lock = path.join(dir, "state.lock");
      const done = path.join(dir, "host-done");
      const finish = `await new Promise((r) => setTimeout(r, 200)); fs.writeFileSync(${JSON.stringify(done)}, ""); process.exit(0);`;
      const host =
        how === "once"
          ? `process.once(${JSON.stringify(signal)}, async () => { ${finish} });`
          : `const h = async () => { process.removeListener(${JSON.stringify(signal)}, h); ${finish} }; process.on(${JSON.stringify(signal)}, h);`;
      const code =
        `const fs = require("fs"); ${host} const { withFileLock } = require(${JSON.stringify(fileLock)});` +
        `setInterval(() => {}, 1000);` +
        `withFileLock(${JSON.stringify(lock)}, async () => { setTimeout(() => process.kill(process.pid, ${JSON.stringify(signal)}), 50);` +
        `  await new Promise(() => {}); });`;
      const { status, signal: sig } = await nodeChild(code);
      assert.deepStrictEqual({ status, sig }, { status: 0, sig: null }, `${signal}, ${how}: the host's handler decided`);
      assert.ok(fs.existsSync(done), `${signal}, ${how}: the host's handler finished`);
      assert.ok(!fs.existsSync(lock), `${signal}, ${how}: the lock went with the exit`);
    }
  }
});

test("a host's once handler that does not exit uses up the first SIGINT; a second one stops the process", async () => {
  if (process.platform === "win32") {
    return;
  }
  const dir = fs.mkdtempSync(path.join(tmp, "sig-twice-"));
  const lock = path.join(dir, "state.lock");
  const ran = path.join(dir, "host-ran");
  const { proc, ended } = await childHolding(
    lock,
    `process.once("SIGINT", () => fs.writeFileSync(${JSON.stringify(ran)}, ""));`
  );
  try {
    proc.kill("SIGINT");
    for (let i = 0; i < 40 && !fs.existsSync(ran); i++) {
      await sleepMs(25);
    }
    assert.ok(fs.existsSync(ran), "the host's handler took the first SIGINT");
    await sleepMs(100);
    assert.ok(fs.existsSync(lock), "b6p stood aside for it: the lock is still held");
    proc.kill("SIGINT");
    const outcome = await Promise.race([ended, sleepMs(2000).then(() => "still running")]);
    assert.notStrictEqual(outcome, "still running", "the second SIGINT was swallowed");
    assert.strictEqual(outcome.sig, "SIGINT", "stopped by the signal");
    assert.ok(!fs.existsSync(lock), "the lock went with it");
  } finally {
    proc.kill("SIGKILL");
  }
});

test("an uncaught exception caught by a capture callback leaves the work its lock", async () => {
  const fileLock = path.join(__dirname, "..", "dist", "persistence", "fileLock.js");
  const lock = path.join(fs.mkdtempSync(path.join(tmp, "capture-")), "state.lock");
  const code =
    `const fs = require("fs"); const { withFileLock } = require(${JSON.stringify(fileLock)});` +
    `process.setUncaughtExceptionCaptureCallback(() => {});` +
    `withFileLock(${JSON.stringify(lock)}, async () => {` +
    `  setTimeout(() => { throw new Error("boom"); }, 0);` +
    `  await new Promise((r) => setTimeout(r, 200));` +
    `  console.log("held " + fs.existsSync(${JSON.stringify(lock)}));` +
    `}).then(() => console.log("released"));`;
  const { status, stdout } = await nodeChild(code);
  assert.strictEqual(status, 0);
  assert.strictEqual(stdout, "held true\nreleased\n");
  assert.ok(!fs.existsSync(lock));
});

test("a lock that cannot be read is waited for at the retry delay, not spun on", async () => {
  const { withFileLock } = require("../dist/persistence/fileLock.js");
  const lock = path.join(fs.mkdtempSync(path.join(tmp, "unreadable-")), "state.lock");
  fs.mkdirSync(lock); // Exists (EEXIST), and reading it fails (EISDIR).
  let reads = 0;
  const error = await withPatchedFs(
    {
      readFile: (original, file, ...rest) => {
        if (String(file) === lock) {
          reads++;
        }
        return original(file, ...rest);
      },
    },
    () => withFileLock(lock, async () => "never", { timeoutMs: 300, retryMs: 50 }).then(() => null, (e) => e)
  );
  assert.match(error.message, /Timed out/);
  assert.ok(reads <= 300 / 50 + 3, `${reads} reads in 300 ms`);
});

test("a close that fails after the stamp is written keeps the acquisition: the work runs and the lock goes after", async () => {
  const { withFileLock } = require("../dist/persistence/fileLock.js");
  const lock = path.join(fs.mkdtempSync(path.join(tmp, "close-")), "state.lock");
  let armed = true;
  const failOnce = (close) =>
    function (...args) {
      const result = close.apply(this, args);
      if (armed) {
        armed = false;
        throw Object.assign(new Error("EIO: close failed"), { code: "EIO" });
      }
      return result;
    };
  const failClose = (handle) => {
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      if (armed) {
        armed = false;
        throw Object.assign(new Error("EIO: close failed"), { code: "EIO" });
      }
    };
    return handle;
  };
  // The close of the lockfile's handle (an async acquire) or descriptor (a synchronous one) fails, once.
  const outcome = await withPatchedFs({ open: async (original, ...a) => failClose(await original(...a)) }, () =>
    withPatchedFsSync({ closeSync: (original, ...a) => failOnce(original)(...a) }, () =>
      withFileLock(lock, async () => "ran", { timeoutMs: 500 }).then(
        (v) => v,
        (e) => e.message
      )
    )
  );
  assert.strictEqual(outcome, "ran");
  assert.ok(!armed, "the close did fail");
  assert.ok(!fs.existsSync(lock));
});

test("on POSIX a lock directory b6p may not write fails at once, naming the refusal", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    return;
  }
  const { withFileLock } = require("../dist/persistence/fileLock.js");
  const dir = fs.mkdtempSync(path.join(tmp, "readonly-"));
  fs.chmodSync(dir, 0o500);
  try {
    const started = Date.now();
    const error = await withFileLock(path.join(dir, "state.lock"), async () => "never", { timeoutMs: 3000 }).then(
      () => null,
      (e) => e
    );
    assert.match(error.message, /could not be created: the file system refused it \(EACCES\)/);
    assert.ok(Date.now() - started < 1000, "not after the wait");
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test("a deleted ~/.b6p is created again: the next write succeeds instead of timing out", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(tmp, "persist-")), "b6p");
  const p = new SharedFilePersistence(dir);
  await p.set("a", 1);
  fs.rmSync(dir, { recursive: true, force: true });
  const started = Date.now();
  await p.set("b", 2);
  assert.ok(Date.now() - started < 2000);
  assert.strictEqual(await new SharedFilePersistence(dir).get("b"), 2);
});

test("the lock under natural timing: many processes, never two inside (a wx marker), nothing left", async () => {
  const fileLock = path.join(__dirname, "..", "dist", "persistence", "fileLock.js");
  const script =
    `const fs = require("fs"); const { withFileLock } = require(${JSON.stringify(fileLock)}); const D = process.argv[1];` +
    `(async () => { for (let i = 0; i < 3; i++) { await withFileLock(D + "/l.lock", async () => {` +
    `  try { fs.writeFileSync(D + "/inside", "", { flag: "wx" }); } catch { fs.appendFileSync(D + "/overlap", "x"); return; }` +
    `  await new Promise((r) => setTimeout(r, 2)); fs.unlinkSync(D + "/inside");` +
    `}, { timeoutMs: 15000, retryMs: 1 }); } })().catch((e) => { fs.appendFileSync(D + "/err", e.message); });`;
  let overlaps = 0;
  const started = Date.now();
  for (let trial = 0; trial < 12; trial++) {
    const dir = fs.mkdtempSync(path.join(tmp, "stress-"));
    await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise((resolve) =>
            require("node:child_process")
              .spawn(process.execPath, ["-e", script, dir], { stdio: "inherit" })
              .on("exit", resolve)
          )
      )
    );
    overlaps += fs.existsSync(path.join(dir, "overlap")) ? 1 : 0;
    assert.ok(
      !fs.existsSync(path.join(dir, "err")),
      fs.existsSync(path.join(dir, "err")) ? fs.readFileSync(path.join(dir, "err"), "utf8") : ""
    );
    assert.deepStrictEqual(fs.readdirSync(dir), [], "nothing left behind");
  }
  assert.strictEqual(overlaps, 0);
  assert.ok(Date.now() - started < 15_000, `${Date.now() - started} ms`);
});

test("a helper on a pattern naming another user may hand git username=b6p, so b6p answers: not configured", async () => {
  // Real git over loopback https: a reset, then an alice@ helper that answers username=b6p and keeps what it is told
  // to store, then b6p. A fetch from https://alice@<host> gets the token from b6p and git hands it to alice's helper.
  const port = 40000 + (process.pid % 20000);
  const host = `gateway.bluestep.net:${port}`;
  const work = fs.mkdtempSync(path.join(tmp, "tls-"));
  const kept = path.join(work, "alice-kept").replace(/\\/g, "/");
  const alice = `!f() { if [ "$1" = get ]; then echo username=b6p; elif [ "$1" = store ]; then cat >> '${kept}'; fi; }; f`;
  const stateFile = path.join(work, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ token: TOKEN, gatewayUrl: `https://${host}`, public: {} }));
  const script = path.join(__dirname, "support", "GitCredentialHelper.js").replace(/\\/g, "/");
  const helper = `!"${process.execPath.replace(/\\/g, "/")}" "${script}" "${stateFile.replace(/\\/g, "/")}"`;
  const config = scratchConfig();
  const add = (key, value) => execFileSync("git", ["config", "--global", "--add", key, value], { env: config.env });
  const key = `credential.https://${host}.helper`;
  add(key, "");
  add(`credential.https://alice@${host}.helper`, alice);
  add(`credential.https://${host}/.helper`, helper); // The trailing slash: a new section, after alice's.

  const openssl = spawnSync("openssl", ["version"]);
  if (process.platform !== "win32" && openssl.status === 0) {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=gateway.bluestep.net",
        "-days",
        "1",
        "-keyout",
        path.join(work, "key.pem"),
        "-out",
        path.join(work, "cert.pem"),
      ],
      { stdio: "ignore" }
    );
    const https = require("node:https");
    const server = https.createServer(
      { key: fs.readFileSync(path.join(work, "key.pem")), cert: fs.readFileSync(path.join(work, "cert.pem")) },
      (req, res) => {
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
        const password = basic ? Buffer.from(basic[1], "base64").toString("utf8").split(":").slice(1).join(":") : "";
        if (password !== TOKEN) {
          res.writeHead(401, { "WWW-Authenticate": 'Basic realm="BlueStep Git"' });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-advertisement" });
        res.end("001e# service=git-upload-pack\n0000");
      }
    );
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      await new Promise((resolve) => {
        require("node:child_process")
          .spawn(
            "git",
            [
              "-c",
              "http.sslVerify=false",
              "-c",
              `http.curloptResolve=gateway.bluestep.net:${port}:127.0.0.1`,
              "ls-remote",
              `https://alice@${host}/kb.git`,
            ],
            { env: { ...config.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" }, stdio: "ignore" }
          )
          .on("exit", resolve);
      });
    } finally {
      server.close();
    }
    assert.ok(
      fs.existsSync(kept) && fs.readFileSync(kept, "utf8").includes(TOKEN),
      "git handed b6p's token to alice's helper"
    );
  }
  const status = await makeService({ config, gatewayUrl: `https://${host}` }).service.setupStatus({ helper });
  assert.strictEqual(status.hosts[0].configured, false);
  assert.deepStrictEqual(status.hosts[0].alsoAsked, [alice]);
});

test("the config file's mode is read under git's lock: a mode changed while b6p waited is the one kept", async () => {
  if (process.platform === "win32") {
    return;
  }
  const config = scratchConfig("[credential]\n\thelper = cache\n");
  fs.chmodSync(config.file, 0o644);
  fs.writeFileSync(`${config.file}.lock`, ""); // Another git is writing it.
  const { service } = makeService({ config });
  const setup = service.setupGit();
  await sleepMs(300);
  fs.chmodSync(config.file, 0o600); // That writer leaves the file owner-only, then lets go.
  fs.unlinkSync(`${config.file}.lock`);
  await setup;
  assert.strictEqual(fs.statSync(config.file).mode & 0o777, 0o600);
  assert.deepStrictEqual(gitGetAll(config.env, GW_KEY), ["", GitCredential.DEFAULT_HELPER]);
});

test("a broken global config: git's own message, not a missing version", async () => {
  const config = scratchConfig("[credential\n\thelper = x\n");
  const error = await makeService({ config })
    .service.setupStatus()
    .then(
      () => null,
      (e) => e
    );
  assert.ok(error instanceof Err.GitCredentialSetupError);
  assert.match(error.message, /bad config line 1/);
  assert.strictEqual(error.exitCode, 128);
});

test("a pull whose host cannot be recorded still succeeds", async () => {
  warnings.length = 0;
  const hosts = {
    record: async () => {
      throw new Error("lock timed out");
    },
  };
  stub.addRepo("654015___8002");
  const workspace = fs.mkdtempSync(path.join(tmp, "ws-"));
  await pullService(hosts, { classid: "654015", seqnum: "8002" })
    .pull({ formulaUrl: `https://${TENANT}/files/1/`, workspacePath: workspace })
    .catch(() => undefined);
  assert.ok(fs.existsSync(path.join(workspace, "U123456", "script-8002", "draft", ".git")));
  assert.ok(warnings.some((w) => w.includes("could not be recorded")));
});

// ── end to end: git asks the helper ───────────────────────────────────

/** `git credential fill` for `request` with a global config that runs the stand-in helper. */
function fill(request, helperConfig, state) {
  const stateFile = path.join(tmp, `state-${++configN}.json`);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const script = path.join(__dirname, "support", "GitCredentialHelper.js").replace(/\\/g, "/");
  const helper = `!"${process.execPath.replace(/\\/g, "/")}" "${script}" "${stateFile.replace(/\\/g, "/")}"`;
  const config = scratchConfig();
  // Written through git config, which quotes the value for config syntax (paths with spaces included).
  for (const key of helperConfig) {
    execFileSync("git", ["config", "--global", "--add", key, helper], { env: config.env });
  }
  return spawnSync("git", ["credential", "fill"], {
    input: request,
    encoding: "utf8",
    env: { ...config.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
  });
}

test("end to end: git credential fill gets the token from the helper, and nothing for a host off the list", () => {
  const state = {
    token: TOKEN,
    gatewayUrl: GATEWAY,
    public: { [PublicKeys.GIT_CREDENTIAL_HOSTS]: { [TENANT]: { recordedAt: 1 } } },
  };
  const scoped = ["credential.https://gateway.bluestep.net.helper", `credential.https://${TENANT}.helper`];
  for (const host of ["gateway.bluestep.net", TENANT]) {
    const run = fill(`protocol=https\nhost=${host}\n\n`, scoped, state);
    assert.strictEqual(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`^username=b6p$`, "m"));
    assert.match(run.stdout, new RegExp(`^password=${TOKEN}$`, "m"));
  }
  // Configured for every host, the helper itself still refuses a lookalike: git finds no credential.
  const everywhere = ["credential.helper"];
  for (const host of ["gateway.bluestep.net.evil.com", "gateway.bluestep.net:8443"]) {
    const run = fill(`protocol=https\nhost=${host}\n\n`, everywhere, state);
    assert.notStrictEqual(run.status, 0, `${host}: ${run.stdout}`);
    assert.ok(!run.stdout.includes(TOKEN));
  }
  const http = fill("protocol=http\nhost=gateway.bluestep.net\n\n", everywhere, state);
  assert.notStrictEqual(http.status, 0);
  assert.ok(!http.stdout.includes(TOKEN));
});

// ── a pull records its host ───────────────────────────────────────────

const stub = createStub();
let stubUrl;

/** A ScriptService over the git proxy stub, with the script's https URL rewritten onto it. */
function pullService(hosts, scriptKey) {
  const ctx = {
    logger,
    prompt: { warn: noop, info: noop, error: noop, confirm: async (_m, o) => o[0], inputBox: async () => undefined },
    progress: { withProgress: async (tasks) => Promise.all(tasks.map((t) => t.execute())) },
    fs: new core.MockFileSystem(),
    gitFs: fs,
    gitToken: async () => stub.TOKEN,
    gitEnv: {},
    gitFetch: (url, init) => fetch(String(url).replace(`https://${TENANT}/`, stubUrl), init),
    gitCredentialHosts: hosts,
    scriptMetadataStore: new core.ScriptMetaDataStore(memoryPersistence()),
  };
  const service = new ScriptService(ctx);
  const url = new URL(`https://${TENANT}/files/1/`);
  service.createParser = () => ({
    url,
    webDavId: "1",
    getScript: async () => [],
    getU: async () => "U123456",
    getScriptName: async () => `script-${scriptKey.seqnum}`,
    getScriptBaseKey: async () => scriptKey,
  });
  return service;
}

test("a script pull that reached the tenant's git proxy records its host; a failed one does not", async () => {
  const workspace = fs.mkdtempSync(path.join(tmp, "ws-"));
  const failed = new GitCredentialHosts(memoryPersistence());
  await pullService(failed, { classid: "654015", seqnum: "8999" })
    .pull({ formulaUrl: `https://${TENANT}/files/1/`, workspacePath: workspace })
    .catch(() => undefined);
  assert.deepStrictEqual(await failed.hosts(), [], "the script has no repo there, so nothing was proven");

  stub.addRepo("654015___8001");
  const hosts = new GitCredentialHosts(memoryPersistence());
  await pullService(hosts, { classid: "654015", seqnum: "8001" })
    .pull({ formulaUrl: `https://${TENANT}/files/1/`, workspacePath: workspace })
    .catch(() => undefined);
  assert.ok(fs.existsSync(path.join(workspace, "U123456", "script-8001", "draft", ".git")), "the draft was cloned");
  assert.deepStrictEqual(await hosts.hosts(), [TENANT]);
});

(async () => {
  execFileSync("git", ["--version"]);
  stubUrl = await stub.listen();
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log("ok   -", name);
    } catch (e) {
      failures++;
      console.error("FAIL -", name, "\n     ", e && e.stack ? e.stack.split("\n").slice(0, 8).join("\n      ") : e);
    }
  }
  await stub.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll GitCredential tests passed.");
})();
