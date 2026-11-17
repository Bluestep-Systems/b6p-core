import type { PlatformContext } from "../PlatformContext";

/**
 * The dependency bundle of the schema subsystem ({@link SchemaService}): the shared {@link PlatformContext} and
 * nothing more. The service talks to an org's `/gql` through `sessionManager` (the same CSRF-managed path script code
 * uses) and reports through `logger`; it reads no script store or cache, so there is nothing to add to the shared half.
 * It is a bundle that is held, never implemented; see {@link PlatformContext}.
 * @lastreviewed null
 */
export interface SchemaContext extends PlatformContext {}
