import { Gateway } from "../constants/Gateway";

/**
 * Why a candidate value is not a gateway access token, or `null` when it is one. The reason never
 * quotes the value: a token pasted into the wrong place must not reach a log or an error message.
 *
 * Checked: the `b6pt_` prefix, something after it, and no whitespace or control characters (which
 * would corrupt the `Authorization` header). The token's alphabet past that is the gateway's
 * business and is not checked.
 * @lastreviewed null
 */
export function gatewayTokenProblem(candidate: string): string | null {
  if (candidate.length === 0) {
    return "it is empty";
  }
  if (!candidate.startsWith(Gateway.TOKEN_PREFIX)) {
    return `it does not start with ${Gateway.TOKEN_PREFIX}`;
  }
  if (candidate.length === Gateway.TOKEN_PREFIX.length) {
    return `it has nothing after ${Gateway.TOKEN_PREFIX}`;
  }
  if (/[\s\u0000-\u001f\u007f]/.test(candidate)) {
    return "it contains whitespace or control characters";
  }
  return null;
}

/**
 * Replace every occurrence of `token` in `text` with a fixed placeholder. Applied to anything the
 * gateway sends back before it reaches a message, so a server that echoes the token cannot leak it.
 * @lastreviewed null
 */
export function redactToken(text: string, token: string | undefined): string {
  if (!token) {
    return text;
  }
  return text.split(token).join(`${Gateway.TOKEN_PREFIX}…`);
}
