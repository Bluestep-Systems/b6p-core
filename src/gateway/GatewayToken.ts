import { Gateway } from "../constants/Gateway";

/**
 * Why a candidate value is not a gateway access token, or `null` when it is one. The reason never
 * quotes the value: a token pasted into the wrong place must not reach a log or an error message.
 *
 * Checked: the `b6pt_` prefix, something after it, and only printable ASCII (`0x21`–`0x7E`).
 * Whitespace and control characters would corrupt the `Authorization` header, and a character
 * outside ASCII (a smart quote or `…` from a paste) makes fetch refuse the header, which would
 * otherwise surface as the gateway being unreachable. Within printable ASCII the alphabet is the
 * gateway's business and is not checked.
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
  if (/[^\x21-\x7e]/.test(candidate)) {
    return "it contains a character that is not printable ASCII (whitespace, a control character or a non-ASCII character)";
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
