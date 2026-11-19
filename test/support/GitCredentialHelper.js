// A stand-in `b6p auth git-credential <action>` for GitCredential.test.js: git runs it as a credential helper
// (`!node GitCredentialHelper.js <state.json>`), it answers through the COMPILED GitCredentialService, exactly as a
// consumer wires it: stdin in, the answer on stdout, exit 0 whatever the answer.
//
// <state.json> holds { token, gatewayUrl, public }: the stored token, the configured gateway URL and the public
// persistence (where GitCredentialHosts keeps the recorded tenant hosts).

const fs = require("node:fs");
const { GitCredentialService, GitCredentialHosts } = require("../../dist/index.js");

const [stateFile, action] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const persistence = {
  get: async (key) => state.public[key],
  set: async () => {
    throw new Error("the helper never writes");
  },
};
const toStderr = (...args) => process.stderr.write(`${args.join(" ")}\n`);
const service = new GitCredentialService({
  logger: { debug: toStderr, info: toStderr, warn: toStderr, error: toStderr },
  token: { token: async () => state.token },
  gatewayUrl: async () => state.gatewayUrl,
  hosts: new GitCredentialHosts(persistence),
  gitConfig: async () => {
    throw new Error("the helper never runs git config");
  },
});

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  process.stdout.write(await service.answer(action, input));
});
