import type { AuthConfig, AuthMethod } from '../auth/types';
import { t } from '../i18n';

export type WellKnownAuthPreset = {
  id: string;
  method: Exclude<AuthMethod, 'none'>;
  label: string;
  description?: string;
  auth: AuthConfig;
};

export const WELL_KNOWN_AUTH_PRESETS: WellKnownAuthPreset[] = [];
