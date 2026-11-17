// Behavioral spec for CsrfFetch against a stand-in of the platform's session and CSRF handling. The stand-in follows
// the order releases up to 26.11.09.00 use: a bearer request signs an anonymous session in, the sign-in renews the
// session (a new JSESSIONID) and drops its CSRF token, and only then is the token checked. So the token `/csrf-token`
// handed the anonymous session is refused, with a 403 that carries no refreshed token (ClickUp 1k5g91bq9ef).
// Dependency-free node script over the COMPILED dist/ (run via `npm test`).

const assert = require("node:assert");
const lib = require("../dist/index.js");

const ORIGIN = "https://org.example.test/";
const BEARER = "b6pt_test-token";
let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push([name, fn]);
}

/** The platform stand-in: sessions by id, each with its CSRF token and whether a bearer has signed it in. */
function platform(options = {}) {
  const sessions = new Map();
  let next = 0;
  const calls = [];
  const newSession = () => {
    const id = `S${++next}`;
    sessions.set(id, { token: undefined, signedIn: false });
    return id;
  };
  const sessionOf = (init) => {
    const cookie = (init.headers && init.headers.Cookie) || "";
    const match = /JSESSIONID=([^;]+)/.exec(cookie);
    return match && sessions.has(match[1]) ? match[1] : undefined;
  };
  const respond = (status, body, headers = {}) => new Response(body, { status, headers });
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const headers = init.headers || {};
    calls.push({ path, method: init.method, csrf: headers["B6P-CSRF-TOKEN"], auth: headers.Authorization });
    let id = sessionOf(init);
    const setCookie = [];
    if (id === undefined) {
      id = newSession();
      setCookie.push(`JSESSIONID=${id}; Path=/; HttpOnly`);
    }
    if (path === "/csrf-token") {
      // Answered in the session as it stands: a bearer on this request does not sign it in.
      const session = sessions.get(id);
      session.token = session.token ?? `T-${id}`;
      return respond(200, session.token, setCookie.length ? { "Set-Cookie": setCookie[0] } : {});
    }
    if (headers.Authorization === `Bearer ${BEARER}` && !sessions.get(id).signedIn) {
      // The sign-in renews the session for its new identity: a new id, and no CSRF token.
      const renewed = newSession();
      sessions.delete(id);
      sessions.get(renewed).signedIn = true;
      id = renewed;
      setCookie.length = 0;
      setCookie.push(`JSESSIONID=${id}; Path=/; HttpOnly`);
    }
    const cookieHeader = setCookie.length ? { "Set-Cookie": setCookie[0] } : {};
    const session = sessions.get(id);
    if (session.token === undefined || headers["B6P-CSRF-TOKEN"] !== session.token) {
      return respond(403, "Invalid or missing CSRF token", cookieHeader);
    }
    if (options.forbidden) {
      return respond(403, "Not permitted", cookieHeader);
    }
    return respond(200, '{"data":{}}', cookieHeader);
  };
  return { fetchImpl, calls };
}

test("a bearer's first request is retried with a token read from the signed-in session", async () => {
  const p = platform();
  const csrf = new lib.CsrfFetch(p.fetchImpl, ORIGIN, { kind: "token", token: BEARER });
  const response = await csrf.postJson("gql", '{"query":"{ x }"}');
  assert.strictEqual(response.status, 200, await response.clone().text());
  assert.deepStrictEqual(
    p.calls.map((c) => c.path),
    ["/csrf-token", "/gql", "/csrf-token", "/gql"]
  );
  assert.notStrictEqual(p.calls[1].csrf, p.calls[3].csrf, "the retry sends the new session's token");
});

test("later requests reuse the token and need no retry", async () => {
  const p = platform();
  const csrf = new lib.CsrfFetch(p.fetchImpl, ORIGIN, { kind: "token", token: BEARER });
  await csrf.postJson("gql", "{}");
  const before = p.calls.length;
  const response = await csrf.postJson("gql", "{}");
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(
    p.calls.slice(before).map((c) => c.path),
    ["/gql"]
  );
});

test("a 403 that is not about the token is retried once, then returned as is", async () => {
  const p = platform({ forbidden: true });
  const csrf = new lib.CsrfFetch(p.fetchImpl, ORIGIN, { kind: "token", token: BEARER });
  await csrf.postJson("gql", "{}");
  const before = p.calls.length;
  const response = await csrf.postJson("gql", "{}");
  assert.strictEqual(response.status, 403);
  assert.strictEqual(await response.text(), "Not permitted");
  assert.deepStrictEqual(
    p.calls.slice(before).map((c) => c.path),
    ["/gql", "/csrf-token", "/gql"]
  );
});

test("every request carries the bearer, the token request included", async () => {
  const p = platform();
  const csrf = new lib.CsrfFetch(p.fetchImpl, ORIGIN, { kind: "token", token: BEARER });
  await csrf.postJson("gql", "{}");
  for (const call of p.calls) {
    assert.strictEqual(call.auth, `Bearer ${BEARER}`, call.path);
  }
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      console.log("ok   -", name);
    } catch (e) {
      failures++;
      console.error("FAIL -", name, "\n     ", e && e.stack ? e.stack.split("\n").slice(0, 6).join("\n      ") : e);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Csrf tests passed.");
})();
