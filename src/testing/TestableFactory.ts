/**
 * Common interface for static factories that support test mode switching.
 * This interface allows both FileSystem and HttpClient to be used interchangeably
 * in test setup code and provides a consistent API for switching between
 * production and test implementations.
 *
 * Note: TypeScript doesn't support static method interfaces directly, so this
 * interface defines the contract for instance methods. Classes implementing this
 * should use static methods and not be instantiated.
 *
 * @template TProvider The type of the provider interface (e.g., FileSystemProvider, HttpClientProvider)
 * @template TMock The type of the mock implementation (e.g., MockFileSystem, MockHttpClient)
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
 * const factory: TestableFactoryStatic<FileSystemProvider, MockFileSystem> = FileSystem;
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
}
