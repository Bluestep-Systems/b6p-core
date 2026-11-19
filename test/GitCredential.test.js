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

const { GitCredentialService, GitCredentialHosts, GitCredential, Err, PublicKeys, ScriptService } = core;
const { credentialHostOf, requestedCredentialHost, gitConfigRunner, parseCredentialRequest } = core;

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

/** A service over memory persistence and a scratch git config; `argv` records every git config call. */
function makeService(options = {}) {
  const persistence = options.persistence ?? memoryPersistence();
  const hosts = new GitCredentialHosts(persistence);
  const config = options.config ?? scratchConfig();
  const real = gitConfigRunner(config.env);
  const argv = [];
  const service = new GitCredentialService({
    logger,
    token: { token: async () => ("token" in options ? options.token : TOKEN) },
    gatewayUrl: async () => options.gatewayUrl ?? GATEWAY,
    hosts,
    gitConfig:
      options.gitConfig ??
      (async (args) => {
        argv.push(args);
        return real(args);
      }),
  });
  return { service, hosts, persistence, config, argv };
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
    gitConfig: async () => ({ code: 0, stdout: "", stderr: "" }),
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

test("a generic helper later in the file than b6p's reset is reported as also asked", async () => {
  const config = scratchConfig();
  const { service } = makeService({ config });
  await service.setupGit();
  fs.appendFileSync(config.file, "[credential]\n\thelper = store\n");
  const status = await service.setupStatus();
  assert.strictEqual(status.hosts[0].configured, true);
  assert.deepStrictEqual(status.hosts[0].alsoAsked, ["store"]);
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

test("removal takes out b6p's entries and their resets only, a host no longer allowed included", async () => {
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
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://old.bluestep.net.helper"), []);
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
  // Each file holds another empty value for those URLs, so b6p's reset is kept rather than risk the user's.
  assert.deepStrictEqual(result.keptResets.sort(), ["https://acme.bluestep.net", "https://gateway.bluestep.net"]);
  assert.deepStrictEqual(gitGetAll(config.env, "credential.https://gateway.bluestep.net.helper"), ["", "mine", ""]);
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
  const scratch = scratchHome({
    ".gitconfig": "[include]\n\tpath = inc.gitconfig\n[user]\n\tname = Someone\n",
    "inc.gitconfig": "[credential]\n\thelper = store\n" + pair("gateway.bluestep.net"),
    "xdg/git/config": pair(TENANT),
  });
  const { service, hosts } = makeService({ config: { env: scratch.env } });
  await hosts.record(`https://${TENANT}/`);
  const status = await service.setupStatus();
  assert.deepStrictEqual(status.otherHelpers, ["store"], "an included generic helper is seen");
  assert.strictEqual(status.configured, true, "entries in an included file and in the XDG file count");
  const again = await service.setupGit();
  assert.deepStrictEqual(again.added, [], "nothing is duplicated into ~/.gitconfig");
  assert.strictEqual(scratch.read(".gitconfig"), "[include]\n\tpath = inc.gitconfig\n[user]\n\tname = Someone\n");

  const result = await service.removeGit();
  assert.deepStrictEqual(result.removed.sort(), [`https://${TENANT}`, "https://gateway.bluestep.net"]);
  const inc = path.join(scratch.home, "inc.gitconfig");
  const xdg = path.join(scratch.home, "xdg", "git", "config");
  assert.deepStrictEqual(entriesOf(scratch.env, inc), ["credential.helper\nstore"]);
  assert.deepStrictEqual(entriesOf(scratch.env, xdg), []);
  assert.strictEqual(scratch.read(".gitconfig"), "[include]\n\tpath = inc.gitconfig\n[user]\n\tname = Someone\n");
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
    gitConfig: async () => ({ code: 3, stdout: "", stderr: "error: could not lock config file\nmore" }),
  });
  const error = await failing.service.setupGit().then(
    () => assert.fail("expected a rejection"),
    (e) => e
  );
  assert.ok(error instanceof Err.GitCredentialSetupError);
  assert.strictEqual(error.exitCode, 3);
  assert.match(error.message, /could not lock config file/);
  assert.ok(!error.message.includes("more"));
  const missing = makeService({ gitConfig: async () => ({ code: -1, stdout: "", stderr: "" }) });
  await assert.rejects(
    missing.service.removeGit(),
    (e) => e instanceof Err.GitCredentialSetupError && e.exitCode === null
  );
  const noGit = gitConfigRunner({ PATH: path.join(tmp, "no-such-dir") });
  assert.strictEqual((await noGit(["--list"])).code, -1);
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
