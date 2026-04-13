/**
 * Keys used for private persistance maps
 */
export enum PrivateKeys {
  /**
   * key for the data we persist for the basic auth map
   */
  BASIC_AUTH = 'b6p:basic_auth',

  /**
   * key for the data we persist for the existing sessions
   */
  SESSIONS = 'b6p:sessions',

  /**
   * key for the data we persist for the github keys map
   */
  GITHUB_KEYS = 'b6p:github_keys',

  /**
   * Key for the data we persist for the GitHub state
   */
  GITHUB_STATE = 'b6p:private_github_state',
}

/**
 * Keys used for public persistance maps
 */
export enum PublicKeys {
  /**
   * Key for the data we persist for the GitHub state
   */
  GITHUB_STATE = 'b6p:public_github_state',

  /**
   * Key for the data we persist for the org cache
   */
  U_CACHE = 'b6p:u_cache',

  /**
   * Key for persisted script metadata (replaces .b6p_metadata.json files)
   */
  SCRIPT_METADATA = 'b6p:script_metadata'
}
