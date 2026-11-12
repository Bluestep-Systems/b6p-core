import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";
import {
  BsjsGitError,
  GitAuthError,
  GitCodeLockedError,
  GitPermissionError,
  GitPushNotEnabledError,
  GitRepoNotFoundError,
  GitServerError,
  GitTransportError,
  GitUnsupportedRequestError,
} from "./errors";

/**
 * The `fetch` this package uses; defaults to the global one (browsers and Node 20+).
 * @lastreviewed null
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The username sent with a token over Basic: the platform ignores it, but Basic needs one.
 * @lastreviewed null
 */
const BASIC_USERNAME = "b6p";

/**
 * The `Authorization` value the git proxy takes: Basic, with the bearer token as the password. Only `btoa` is used
 * (no `Buffer`), so it works in a browser.
 * @lastreviewed null
 */
export function gitAuthHeader(token: string): string {
  return `Basic ${btoa(`${BASIC_USERNAME}:${token}`)}`;
}

/**
 * Turns a non-200 answer of the git proxy into the typed error the caller can act on. The proxy answers in its own
 * words (see `GitProxyController`): 401 challenge, 403 with the gate's reason, 404 for absent-or-invisible, 415 for a
 * body it cannot forward, 502 for the forge.
 * @lastreviewed null
 */
export function refusalFor(status: number, body: string): BsjsGitError {
  const reason = body.trim();
  switch (status) {
    case 401:
      return new GitAuthError();
    case 403:
      if (/push is not enabled/i.test(reason)) {
        return new GitPushNotEnabledError(reason);
      }
      if (/fixed id or is frozen/i.test(reason)) {
        return new GitCodeLockedError(reason);
      }
      return new GitPermissionError(reason);
    case 404:
      return new GitRepoNotFoundError();
    case 415:
      return new GitUnsupportedRequestError();
    default:
      return new GitServerError(status);
  }
}

async function collect(body: AsyncIterable<Uint8Array> | undefined): Promise<Uint8Array | undefined> {
  if (!body) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    length += chunk.length;
  }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}

async function* stream(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The isomorphic-git transport for the platform's git proxy: `fetch` underneath, the bearer token sent as Basic on
 * every request (no per-call `onAuth` round trip), and every non-200 answer thrown as a typed {@link BsjsGitError}
 * rather than isomorphic-git's generic `HttpError`.
 * @lastreviewed null
 */
export function createProxyHttp(token: string, fetchImpl?: FetchLike): HttpClient {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  const authorization = gitAuthHeader(token);
  return {
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      const body = await collect(req.body);
      let response: Response;
      try {
        response = await doFetch(req.url, {
          method: req.method ?? "GET",
          headers: { ...req.headers, Authorization: authorization },
          body: body as BodyInit | undefined,
        });
      } catch (cause) {
        throw new GitTransportError(cause);
      }
      if (response.status !== 200) {
        throw refusalFor(response.status, await response.text().catch(() => ""));
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        url: req.url,
        method: req.method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers,
        body: response.body ? stream(response.body) : undefined,
      };
    },
  };
}
