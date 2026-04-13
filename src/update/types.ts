/**
 * Information about an available update.
 * @lastreviewed null
 */
export interface UpdateInfo {
  version: string;
  downloadUrl: string;
  releaseNotes: string;
  publishedAt: string;
}

/**
 * GitHub release information from the API.
 * @lastreviewed null
 */
export interface GithubRelease {
  url: string;
  html_url: string;
  assets_url: string;
  upload_url: string;
  tarball_url: string;
  zipball_url: string;
  id: number;
  node_id: string;
  tag_name: string;
  target_commitish: string;
  name: string | null;
  body: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string;
  author: {
    login: string;
    id: number;
    node_id: string;
    avatar_url: string;
    gravatar_id: string;
    url: string;
    html_url: string;
    followers_url: string;
    following_url: string;
    gists_url: string;
    starred_url: string;
    subscriptions_url: string;
    organizations_url: string;
    repos_url: string;
    events_url: string;
    received_events_url: string;
    type: string;
    site_admin: boolean;
  };
  assets: Array<{
    url: string;
    browser_download_url: string;
    id: number;
    node_id: string;
    name: string;
    label: string | null;
    state: string;
    content_type: string;
    size: number;
    download_count: number;
    created_at: string;
    updated_at: string;
    uploader: {
      login: string;
      id: number;
    };
  }>;
}

/**
 * Client state information for update tracking.
 * @lastreviewed null
 */
export interface ClientInfo {
  version: string;
  lastChecked: number;
  githubToken: string | null;
  setupShown: boolean;
}

/**
 * Configuration options for the update service.
 * @lastreviewed null
 */
export interface UpdateServiceConfig {
  /** Current version of the application */
  currentVersion: string;
  /** GitHub repository owner */
  repoOwner: string;
  /** GitHub repository name */
  repoName: string;
  /** Whether update checking is enabled */
  enabled: boolean;
  /** Debug mode version override (for testing) */
  versionOverride?: string;
}
