import type { ProviderConfig } from '../types';
import type { AuthRuntimeConfig } from '../auth/types';

export type ProviderMigrationConfig = Partial<
  Omit<ProviderConfig, 'auth'>
> & {
  auth?: AuthRuntimeConfig;
};

export interface ProviderMigrationCandidate {
  provider: ProviderMigrationConfig;
}

export interface ProviderMigrationSource {
  readonly id: string;
  readonly displayName: string;
  /**
   * Try to auto-detect a config file for this application.
   * Return the file path if found, otherwise undefined.
   */
  detectConfigFile(): Promise<string | undefined>;
  /**
   * Import providers from config content (not file path).
   * Implementations should throw an Error with a user-friendly message.
   */
  importFromConfigContent(
    content: string,
  ): Promise<readonly ProviderMigrationCandidate[]>;
}
