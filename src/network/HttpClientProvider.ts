import { Http, MimeTypes } from "../constants";

/**
 * Interface defining HTTP client operations needed for network requests.
 * This allows us to create both real and mock implementations for testing.
 *
 * Mirrors the global fetch API to provide a consistent abstraction layer
 * for HTTP operations that can be easily mocked for testing.
 */
export interface HttpClientProvider {
  /**
   * Perform an HTTP request using the Fetch API.
   *
   * @param url The URL to request
   * @param options Optional request configuration
   * @returns A promise that resolves to the HTTP response
   * @throws Error if the request fails
   *
   * @example
   * ```typescript
   * const response = await httpClient.fetch('https://example.com/api/data');
   * const data = await response.json();
   * ```
   */
  fetch(url: string | URL, options?: RequestInit): Promise<Response>;
}

/**
 * Real implementation that delegates to the global fetch API.
 */
export class GlobalHttpClient implements HttpClientProvider {
  async fetch(url: string | URL, options?: RequestInit): Promise<Response> {
    return globalThis.fetch(url, options);
  }
}

/**
 * Mock implementation for testing purposes.
 *
 * Provides a configurable HTTP client that can return predefined responses
 * or throw errors for specific URLs, enabling comprehensive testing of
 * network-dependent code without making actual HTTP requests.
 */
export class MockHttpClient implements HttpClientProvider {
  private responses = new Map<string, Response | Error>();
  private requestLog: Array<{ url: string; options?: RequestInit }> = [];

  constructor() {
    // Initialize with some default behavior
  }

  /**
   * Set up a mock response for a specific URL.
   * This is the primary method for preparing test data.
   *
   * @param url The URL that should return this mock response
   * @param response The mock Response object to return
   *
   * @example
   * ```typescript
   * mockHttp.setMockResponse('https://api.example.com/data', new Response(
   *   JSON.stringify({ id: 1, name: 'Test' }),
   *   { status: 200, headers: { 'Content-Type': 'application/json' } }
   * ));
   * ```
   */
  setMockResponse(url: string, response: Response): void {
    this.responses.set(this.normalizeUrl(url), response);
  }

  /**
   * Set up a mock response with JSON data for a specific URL.
   * Convenience method for the common case of returning JSON data.
   *
   * @param url The URL that should return this mock response
   * @param data The data to serialize as JSON
   * @param status Optional HTTP status code (default: 200)
   * @param headers Optional additional headers
   *
   * @example
   * ```typescript
   * mockHttp.setMockJsonResponse('https://api.example.com/user',
   *   { id: 1, username: 'test' },
   *   200,
   *   { 'X-Custom-Header': 'value' }
   * );
   * ```
   */
  setMockJsonResponse(url: string, data: unknown, status: number = 200, headers: Record<string, string> = {}): void {
    const response = new Response(JSON.stringify(data), {
      status,
      headers: {
        [Http.Headers.CONTENT_TYPE]: MimeTypes.APPLICATION_JSON,
        ...headers
      }
    });
    this.setMockResponse(url, response);
  }

  /**
   * Set up a mock response with plain text for a specific URL.
   * Convenience method for returning text/plain responses.
   *
   * @param url The URL that should return this mock response
   * @param text The text content to return
   * @param status Optional HTTP status code (default: 200)
   * @param headers Optional additional headers
   *
   * @example
   * ```typescript
   * mockHttp.setMockTextResponse('https://api.example.com/csrf-token',
   *   'abc123token',
   *   200
   * );
   * ```
   */
  setMockTextResponse(url: string, text: string, status: number = 200, headers: Record<string, string> = {}): void {
    const response = new Response(text, {
      status,
      headers: {
        [Http.Headers.CONTENT_TYPE]: MimeTypes.TEXT_PLAIN,
        ...headers
      }
    });
    this.setMockResponse(url, response);
  }

  /**
   * Configure a URL to throw an error when fetched.
   * Useful for testing error handling scenarios.
   *
   * @param url The URL that should throw an error
   * @param error The error to throw when the URL is fetched
   *
   * @example
   * ```typescript
   * mockHttp.setMockError(
   *   'https://api.example.com/failing-endpoint',
   *   new Error('Network timeout')
   * );
   * ```
   */
  setMockError(url: string, error: Error): void {
    this.responses.set(this.normalizeUrl(url), error);
  }

  /**
   * Clear all mock responses and request logs.
   * Resets the mock HTTP client to an empty state.
   *
   * @example
   * ```typescript
   * // Set up some responses
   * mockHttp.setMockJsonResponse('https://api.example.com/data', { id: 1 });
   *
   * // Clear everything for the next test
   * mockHttp.clearMocks();
   * ```
   */
  clearMocks(): void {
    this.responses.clear();
    this.requestLog = [];
  }

  /**
   * Get all URLs that have been requested.
   * Useful for verifying that expected requests were made during tests.
   *
   * @returns Array of URLs that were requested
   *
   * @example
   * ```typescript
   * // Make some requests
   * await httpClient.fetch('https://api.example.com/data');
   * await httpClient.fetch('https://api.example.com/user');
   *
   * // Verify the requests
   * const requests = mockHttp.getRequestLog();
   * assert.strictEqual(requests.length, 2);
   * assert.strictEqual(requests[0].url, 'https://api.example.com/data');
   * ```
   */
  getRequestLog(): Array<{ url: string; options?: RequestInit }> {
    return [...this.requestLog];
  }

  /**
   * Get the last request that was made.
   * Convenience method for checking the most recent request.
   *
   * @returns The last request, or undefined if no requests have been made
   *
   * @example
   * ```typescript
   * await httpClient.fetch('https://api.example.com/data', { method: 'POST' });
   *
   * const lastRequest = mockHttp.getLastRequest();
   * assert.strictEqual(lastRequest?.url, 'https://api.example.com/data');
   * assert.strictEqual(lastRequest?.options?.method, 'POST');
   * ```
   */
  getLastRequest(): { url: string; options?: RequestInit } | undefined {
    return this.requestLog[this.requestLog.length - 1];
  }

  /**
   * Check if a specific URL has been requested.
   *
   * @param url The URL to check for
   * @returns true if the URL was requested, false otherwise
   *
   * @example
   * ```typescript
   * await httpClient.fetch('https://api.example.com/data');
   *
   * assert.strictEqual(mockHttp.wasRequested('https://api.example.com/data'), true);
   * assert.strictEqual(mockHttp.wasRequested('https://api.example.com/other'), false);
   * ```
   */
  wasRequested(url: string): boolean {
    const normalized = this.normalizeUrl(url);
    return this.requestLog.some(req => this.normalizeUrl(req.url) === normalized);
  }

  /**
   * Get the number of times a specific URL was requested.
   *
   * @param url The URL to count requests for
   * @returns The number of times the URL was requested
   *
   * @example
   * ```typescript
   * await httpClient.fetch('https://api.example.com/data');
   * await httpClient.fetch('https://api.example.com/data');
   *
   * assert.strictEqual(mockHttp.getRequestCount('https://api.example.com/data'), 2);
   * ```
   */
  getRequestCount(url: string): number {
    const normalized = this.normalizeUrl(url);
    return this.requestLog.filter(req => this.normalizeUrl(req.url) === normalized).length;
  }

  /**
   * Set up multiple mock responses at once for testing.
   *
   * @param responses Map of URLs to Response objects
   *
   * @example
   * ```typescript
   * mockHttp.setMockResponses({
   *   'https://api.example.com/user': new Response(JSON.stringify({ id: 1 })),
   *   'https://api.example.com/posts': new Response(JSON.stringify([{ id: 1, title: 'Test' }]))
   * });
   * ```
   */
  setMockResponses(responses: Record<string, Response>): void {
    Object.entries(responses).forEach(([url, response]) => {
      this.setMockResponse(url, response);
    });
  }

  /**
   * Normalize URL for consistent lookup.
   * Converts URL objects to strings and handles trailing slashes.
   */
  private normalizeUrl(url: string | URL): string {
    const urlString = url instanceof URL ? url.href : url.toString();
    // Remove trailing slash for consistency
    return urlString.endsWith('/') && urlString.length > 1
      ? urlString.slice(0, -1)
      : urlString;
  }

  async fetch(url: string | URL, options?: RequestInit): Promise<Response> {
    const urlString = url instanceof URL ? url.href : url.toString();
    const normalizedUrl = this.normalizeUrl(urlString);

    // Log the request
    this.requestLog.push({ url: urlString, options });

    // Check if we have a mock response for this URL
    const mockResponse = this.responses.get(normalizedUrl);

    if (!mockResponse) {
      // No mock configured - throw an error to catch unhandled requests in tests
      throw new Error(`No mock response configured for URL: ${urlString}`);
    }

    if (mockResponse instanceof Error) {
      throw mockResponse;
    }

    // Clone the response so it can be used multiple times
    return mockResponse.clone();
  }
}
