import type { FileSystem, Logger, Progress, Prompt } from "./providers";
import type { SessionManager } from "./session/SessionManager";

/**
 * The services every subsystem of the SDK needs, regardless of what it does.
 *
 * This is the shared half of a subsystem's dependency bundle. A subsystem extends
 * it with what only that subsystem reads — {@link ScriptContext} adds the script
 * metadata store, the org cache and the TypeScript lib directories — and
 * {@link B6PCore} builds the shared half **once** and spreads it into each.
 *
 * The split exists so the shared members have a single construction site. With one
 * flat per-subsystem interface, a second service needing `fs` + `sessionManager` +
 * `logger` + `prompt` + `progress` would restate all five, `B6PCore`'s constructor
 * would grow a second literal repeating them, and adding a provider would mean
 * editing every one. Here it is one edit.
 *
 * `sessionManager` sits alongside the raw providers deliberately: it is
 * core-constructed rather than consumer-supplied, but every subsystem that talks
 * to the platform talks through it, which is the only membership test that matters.
 *
 * Note this is a bundle that is **held, never implemented**. Nothing should satisfy
 * it by being a larger object that happens to contain these members — that is how a
 * dependency bundle decays back into a service locator. See {@link ScriptContext}.
 * @lastreviewed null
 */
export interface PlatformContext {
  readonly fs: FileSystem;
  readonly sessionManager: SessionManager;
  readonly logger: Logger;
  readonly prompt: Prompt;
  readonly progress: Progress;
  isDebugMode(): boolean;
}
