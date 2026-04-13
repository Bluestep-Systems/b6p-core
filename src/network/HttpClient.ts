import { HttpClientProvider, GlobalHttpClient, MockHttpClient } from './HttpClientProvider';
import type { TestableFactoryStatic } from '../testing/TestableFactory';

/**
 * Namespace for managing the HTTP client provider.
 * This allows us to switch between real and mock implementations for testing.
 * Conforms to the TestableFactory pattern.
 */
export namespace HttpClient {
  let instance: HttpClientProvider = new GlobalHttpClient();
  let isTestMode = false;

  /**
   * Get the current HTTP client provider instance.
   */
  export function getInstance(): HttpClientProvider {
    return instance;
  }

  /**
   * Set a custom HTTP client provider (mainly for testing).
   */
  export function setProvider(provider: HttpClientProvider): void {
    instance = provider;
  }

  /**
   * Switch to mock mode for testing.
   */
  export function enableTestMode(): MockHttpClient {
    const mockProvider = new MockHttpClient();
    instance = mockProvider;
    isTestMode = true;
    return mockProvider;
  }

  /**
   * Switch back to real global fetch.
   */
  export function enableProductionMode(): void {
    instance = new GlobalHttpClient();
    isTestMode = false;
  }

  /**
   * Check if we're currently in test mode.
   */
  export function getIsTestMode(): boolean {
    return isTestMode;
  }

  /**
   * Reset to default state (production mode).
   */
  export function reset(): void {
    enableProductionMode();
  }
}

// Type assertion to ensure HttpClient conforms to TestableFactory pattern
const _typeCheck: TestableFactoryStatic<HttpClientProvider, MockHttpClient> = HttpClient;
// Prevent unused variable warning
void _typeCheck;
