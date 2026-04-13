import type { BasicAuthParams } from '../types';
import type { ILogger, IPersistence, IPrompt } from '../providers';

const PERSISTENCE_KEY = 'basicAuth';

/**
 * Core-layer basic auth provider.
 *
 * Replaces `BasicAuthManager` + `BasicAuth` + `AuthObject` with a flat class
 * that delegates credential prompting and storage to the provider interfaces.
 */
export class BasicAuthProvider {
  constructor(
    private readonly persistence: IPersistence,
    private readonly prompt: IPrompt,
    private readonly logger: ILogger,
  ) {}

  /**
   * Returns the Basic auth header value (`"Basic <base64>"`).
   * Prompts for credentials if none are stored.
   */
  async authHeaderValue(): Promise<string> {
    const creds = await this.getOrCreate();
    const encoded = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
    return `Basic ${encoded}`;
  }

  /**
   * Get stored credentials, or prompt and store them if absent.
   */
  async getOrCreate(): Promise<BasicAuthParams> {
    const raw = await this.persistence.getSecret(PERSISTENCE_KEY);
    if (raw) {
      return JSON.parse(raw) as BasicAuthParams;
    }
    this.prompt.info('No existing credentials found, please enter new credentials.');
    return this.createNew();
  }

  /**
   * Prompt for new credentials and store them.
   */
  async createNew(): Promise<BasicAuthParams> {
    const username = await this.prompt.inputBox({ prompt: 'Enter your username' });
    if (username === undefined) {
      throw new Error('Credential entry cancelled');
    }
    const password = await this.prompt.inputBox({ prompt: 'Enter your password', password: true });
    if (password === undefined) {
      throw new Error('Credential entry cancelled');
    }
    const creds: BasicAuthParams = { username, password };
    await this.persistence.setSecret(PERSISTENCE_KEY, JSON.stringify(creds));
    this.logger.info('Credentials stored');
    return creds;
  }

  /**
   * Update existing credentials (prompts, keeps old values on empty input).
   */
  async update(): Promise<BasicAuthParams> {
    const existing = await this.getOrCreate();
    const newUsername = await this.prompt.inputBox({
      prompt: 'Enter new username (empty to keep current)',
      value: existing.username,
    });
    if (newUsername === undefined) {
      this.prompt.info('Cancelled');
      return existing;
    }
    const newPassword = await this.prompt.inputBox({
      prompt: 'Enter new password (empty to keep current)',
      password: true,
    });
    if (newPassword === undefined) {
      this.prompt.info('Cancelled');
      return existing;
    }
    const creds: BasicAuthParams = {
      username: newUsername || existing.username,
      password: newPassword || existing.password,
    };
    await this.persistence.setSecret(PERSISTENCE_KEY, JSON.stringify(creds));
    if (creds.username === existing.username && creds.password === existing.password) {
      this.prompt.info('No changes made to credentials.');
    } else {
      this.prompt.info('Credentials updated!');
    }
    return creds;
  }

  /**
   * Clear stored credentials.
   */
  async clear(): Promise<void> {
    await this.persistence.deleteSecret(PERSISTENCE_KEY);
  }

  /**
   * Whether credentials are currently stored.
   */
  async hasCredentials(): Promise<boolean> {
    const raw = await this.persistence.getSecret(PERSISTENCE_KEY);
    return raw !== undefined;
  }
}
