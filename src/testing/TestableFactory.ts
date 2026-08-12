/**
 * Common interface for static factories that support test mode switching.
 *
 * The sole implementor today is `HttpClient`, which asserts its conformance at
 * compile time via the `TestableFactoryStatic` type-check in
 * [HttpClient.ts](../network/HttpClient.ts). (An earlier draft of this doc named a
 * `FileSystem` factory alongside it; no such type exists — the file system reaches
 * core through the injected {@link FileSystem} provider, not a swappable static.)
 *
 * Note: TypeScript doesn't support static method interfaces directly, so this
 * interface defines the contract for instance methods. Classes implementing this
 * should use static methods and not be instantiated.
 *
 * @template TProvider The type of the provider interface (e.g. `HttpClientProvider`)
 * @template TMock The type of the mock implementation (e.g. `MockHttpClient`)
 * @lastreviewed null
 */
export interface TestableFactory<TProvider, TMock extends TProvider> {
  /**
   * Get the current provider instance.
   * In production mode, returns the real implementation.
   * In test mode, returns the mock implementation.
   */
  getInstance(): TProvider;

  /**
   * Set a custom provider (mainly for testing).
   * @param provider The provider instance to use
   */
  setProvider(provider: TProvider): void;

  /**
   * Switch to mock mode for testing.
   * @returns The mock provider instance for configuration
   */
  enableTestMode(): TMock;

  /**
   * Switch back to real production implementation.
   */
  enableProductionMode(): void;

  /**
   * Check if we're currently in test mode.
   */
  getIsTestMode(): boolean;

  /**
   * Reset to default state (production mode).
   */
  reset(): void;
}

/**
 * Type helper for static class implementations of {@link TestableFactory}.
 * This allows us to type-check that a static class conforms to the factory pattern.
 *
 * @example
 * ```typescript
 * const factory: TestableFactoryStatic<HttpClientProvider, MockHttpClient> = HttpClient;
 * factory.enableTestMode();
 * ```
 */
export type TestableFactoryStatic<TProvider, TMock extends TProvider> = {
  getInstance(): TProvider;
  setProvider(provider: TProvider): void;
  enableTestMode(): TMock;
  enableProductionMode(): void;
  getIsTestMode(): boolean;
  reset(): void;
};
