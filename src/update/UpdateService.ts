import { FileExtensions, GitHubUrls, Http } from '../constants';
import { PrivateKeys } from '../persistence';
import type { IPersistence, ILogger } from '../providers';
import type { UpdateInfo, GithubRelease, ClientInfo, UpdateServiceConfig } from './types';

/**
 * Core update checking service for checking GitHub releases.
 * Platform-agnostic - does not depend on VS Code APIs.
 *
 * @lastreviewed null
 */
export class UpdateService {
  private readonly UPDATE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

  constructor(
    private readonly persistence: IPersistence,
    private readonly logger: ILogger,
    private readonly config: UpdateServiceConfig,
    fetchFn?: (url: string | URL, init?: RequestInit) => Promise<Response>
  ) {
    // Store fetch function, converting signature to match standard fetch
    this.fetchImpl = fetchFn
      ? ((input: string | URL | Request, init?: RequestInit) => {
          if (input instanceof Request) {
            throw new Error('Request objects are not supported by UpdateService');
          }
          return fetchFn(input, init);
        })
      : globalThis.fetch.bind(globalThis);
  }

  private readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  /**
   * Get the fetch function to use.
   * @lastreviewed null
   */
  private get fetch(): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    return this.fetchImpl;
  }

  /**
   * Get the current application version, respecting debug overrides.
   * @returns Current version string
   * @lastreviewed null
   */
  getCurrentVersion(): string {
    if (this.config.versionOverride) {
      this.logger.info(`Using debug mode version override: ${this.config.versionOverride}`);
      return this.config.versionOverride;
    }
    return this.config.currentVersion;
  }

  /**
   * Get GitHub authentication headers.
   * @returns Headers object with authentication if configured
   * @lastreviewed null
   */
  private async getGitHubHeaders(): Promise<Record<string, string>> {
    return {
      [Http.Headers.USER_AGENT]: Http.Headers.USER_AGENT_B6P,
      [Http.Headers.ACCEPT]: Http.Headers.GITHUB_API_ACCEPT
    };
  }

  /**
   * Get the client state from persistence.
   * @returns ClientInfo object
   * @lastreviewed null
   */
  private async getClientState(): Promise<ClientInfo> {
    const defaultState: ClientInfo = {
      version: this.config.currentVersion,
      lastChecked: 0,
      githubToken: null,
      setupShown: false
    };

    const state = await this.persistence.get<ClientInfo>(PrivateKeys.GITHUB_STATE);
    return state ?? defaultState;
  }

  /**
   * Update the client state in persistence.
   * @param updates Partial updates to apply to the state
   * @lastreviewed null
   */
  private async updateClientState(updates: Partial<ClientInfo>): Promise<void> {
    const currentState = await this.getClientState();
    const newState = { ...currentState, ...updates };
    await this.persistence.set(PrivateKeys.GITHUB_STATE, newState);
  }

  /**
   * Check if enough time has passed since the last update check.
   * @returns True if a check is needed
   * @lastreviewed null
   */
  async shouldCheckForUpdates(): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    const state = await this.getClientState();
    const lastCheck = state.lastChecked || 0;
    const now = Date.now();

    return (now - lastCheck) >= this.UPDATE_INTERVAL;
  }

  /**
   * Get the latest release from GitHub API.
   * @returns The latest non-draft, non-prerelease GitHub release or null if none found
   * @lastreviewed null
   */
  async getLatestRelease(): Promise<GithubRelease | null> {
    try {
      const url = `${GitHubUrls.API_BASE}${GitHubUrls.REPOS_PATH}${this.config.repoOwner}/${this.config.repoName}${GitHubUrls.RELEASES_LATEST_PATH}`;

      const response = await this.fetch(url, {
        method: Http.Methods.GET,
        headers: await this.getGitHubHeaders(),
        signal: AbortSignal.timeout(10_000) // 10 second timeout
      });

      if (response.status === 404) {
        // No releases found
        return null;
      }

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const release = await response.json() as GithubRelease;

      // Filter out drafts and pre-releases by default
      if (release.draft || release.prerelease) {
        return null;
      }

      return release;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('Update check timeout');
        }
        throw new Error(`GitHub API fetch error: ${error.message}`);
      }
      throw new Error(`Failed to parse GitHub API response: ${error}`);
    }
  }

  /**
   * Get all available releases (for manual checking).
   * @param includePrerelease Whether to include prerelease versions
   * @returns Array of GitHub releases
   * @lastreviewed null
   */
  async getAllReleases(includePrerelease = false): Promise<GithubRelease[]> {
    try {
      const url = `${GitHubUrls.API_BASE}${GitHubUrls.REPOS_PATH}${this.config.repoOwner}/${this.config.repoName}${GitHubUrls.RELEASES_PATH}`;

      const response = await this.fetch(url, {
        method: Http.Methods.GET,
        headers: await this.getGitHubHeaders(),
      });

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const releases = await response.json() as GithubRelease[];

      const filteredReleases = releases.filter(release => {
        if (release.draft) {
          return false;
        }
        if (!includePrerelease && release.prerelease) {
          return false;
        }
        return true;
      });

      return filteredReleases;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('Update check timeout');
        }
        throw new Error(`GitHub API fetch error: ${error.message}`);
      }
      throw new Error(`Failed to parse GitHub API response: ${error}`);
    }
  }

  /**
   * Compare version strings to determine if newVersion is newer than currentVersion.
   * @param newVersion The new version string to compare
   * @param currentVersion The current version string to compare against
   * @returns True if newVersion is newer than currentVersion
   * @lastreviewed null
   */
  isNewerVersion(newVersion: string, currentVersion: string): boolean {
    const parseVersion = (version: string) => {
      return version.split('.').map(num => parseInt(num, 10));
    };

    const newParts = parseVersion(newVersion);
    const currentParts = parseVersion(currentVersion);

    // Ensure both arrays have the same length
    const maxLength = Math.max(newParts.length, currentParts.length);
    while (newParts.length < maxLength) {
      newParts.push(0);
    }
    while (currentParts.length < maxLength) {
      currentParts.push(0);
    }

    for (let i = 0; i < maxLength; i++) {
      if (newParts[i] > currentParts[i]) {
        return true;
      } else if (newParts[i] < currentParts[i]) {
        return false;
      }
    }

    return false; // Versions are equal
  }

  /**
   * Get download URL for the extension package from release assets.
   * @param release The GitHub release object
   * @returns The download URL for the .vsix file or the release page
   * @lastreviewed null
   */
  getDownloadUrl(release: GithubRelease): string {
    // Look for .vsix file in assets
    const vsixAsset = release.assets.find(asset => asset.name.endsWith(FileExtensions.VSIX));
    if (vsixAsset) {
      return vsixAsset.browser_download_url;
    }

    // Fallback to release page
    return `${GitHubUrls.BASE}/${this.config.repoOwner}/${this.config.repoName}/releases/tag/${release.tag_name}`;
  }

  /**
   * Check for updates and return update info if available.
   * Updates the last checked timestamp.
   *
   * @returns UpdateInfo if a newer version is available, null otherwise
   * @lastreviewed null
   */
  async checkForUpdates(): Promise<UpdateInfo | null> {
    try {
      if (!this.config.enabled) {
        this.logger.info('Update checking is disabled');
        return null;
      }

      const currentVersion = this.getCurrentVersion();
      const latestRelease = await this.getLatestRelease();

      if (!latestRelease) {
        this.logger.info('No releases found on GitHub');
        return null;
      }

      const latestVersion = latestRelease.tag_name.replace(/^v/, ''); // Remove 'v' prefix if present

      if (this.isNewerVersion(latestVersion, currentVersion)) {
        const updateInfo: UpdateInfo = {
          version: latestVersion,
          downloadUrl: this.getDownloadUrl(latestRelease),
          releaseNotes: latestRelease.body,
          publishedAt: latestRelease.published_at
        };

        this.logger.info(`Update available: v${currentVersion} -> v${latestVersion}`);

        // Update last checked timestamp
        await this.updateClientState({ lastChecked: Date.now() });

        return updateInfo;
      }

      this.logger.info(`Already running latest version: v${currentVersion}`);

      // Update last checked timestamp even if no update available
      await this.updateClientState({ lastChecked: Date.now() });

      return null;
    } catch (error) {
      this.logger.error(`Error checking for updates: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  /**
   * Check for updates only if enough time has passed since the last check.
   *
   * @returns UpdateInfo if a newer version is available, null otherwise
   * @lastreviewed null
   */
  async checkForUpdatesIfNeeded(): Promise<UpdateInfo | null> {
    if (!(await this.shouldCheckForUpdates())) {
      this.logger.info('Skipping update check - not enough time has passed since last check');
      return null;
    }

    return this.checkForUpdates();
  }

  /**
   * Download a file from a URL.
   * Platform-agnostic - returns raw bytes.
   *
   * @param downloadUrl URL to download from
   * @returns The downloaded file as a Uint8Array
   * @lastreviewed null
   */
  async downloadFile(downloadUrl: string): Promise<Uint8Array> {
    try {
      const response = await this.fetch(downloadUrl, {
        method: Http.Methods.GET,
        headers: {
          [Http.Headers.USER_AGENT]: Http.Headers.USER_AGENT_B6P,
        },
        signal: AbortSignal.timeout(30_000) // 30 second timeout
      });

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('Download timeout');
        }
        throw new Error(`Download error: ${error.message}`);
      }
      throw new Error('Download failed with unknown error');
    }
  }

  /**
   * Mark the setup guide as shown.
   * @lastreviewed null
   */
  async markSetupShown(): Promise<void> {
    await this.updateClientState({ setupShown: true });
  }

  /**
   * Check if the setup guide has been shown.
   * @returns True if setup guide has been shown
   * @lastreviewed null
   */
  async hasShownSetup(): Promise<boolean> {
    const state = await this.getClientState();
    return state.setupShown;
  }

  /**
   * Get version notes for the current version.
   * Checks if version has changed since last run.
   *
   * @returns Object with version info and whether it changed
   * @lastreviewed null
   */
  async getVersionNotes(): Promise<{ currentVersion: string; storedVersion: string; hasChanged: boolean }> {
    const state = await this.getClientState();
    const currentVersion = this.getCurrentVersion();
    const storedVersion = state.version;
    const hasChanged = storedVersion !== currentVersion;

    this.logger.info(`Stored version: ${storedVersion}, Current version: ${currentVersion}`);

    if (hasChanged) {
      // Update stored version
      await this.updateClientState({ version: currentVersion });
    }

    return {
      currentVersion,
      storedVersion,
      hasChanged
    };
  }
}
