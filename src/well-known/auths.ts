import type { AuthConfig, AuthMethod } from '../auth/types';
import { t } from '../i18n';

export type WellKnownAuthPreset = {
  id: string;
  method: Exclude<AuthMethod, 'none'>;
  label: string;
  description?: string;
  auth: AuthConfig;
};

export const WELL_KNOWN_AUTH_PRESETS: WellKnownAuthPreset[] = [
  {
    id: 'google-vertex-ai',
    method: 'oauth2',
    label: t('Google Vertex AI'),
    description: t('OAuth 2.0 for Google Cloud Platform'),
    auth: {
      method: 'oauth2',
      label: t('Google Vertex AI'),
      description: t('OAuth 2.0 for Google Cloud Platform'),
      oauth: {
        grantType: 'authorization_code',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientId: '',
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        pkce: true,
      },
    },
  },
  {
    id: 'azure-openai',
    method: 'oauth2',
    label: t('Azure OpenAI'),
    description: t('Azure Active Directory OAuth 2.0'),
    auth: {
      method: 'oauth2',
      label: t('Azure OpenAI'),
      description: t('Azure Active Directory OAuth 2.0'),
      oauth: {
        grantType: 'authorization_code',
        authorizationUrl:
          'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/authorize',
        tokenUrl: 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token',
        clientId: '',
        scopes: ['https://cognitiveservices.azure.com/.default'],
        pkce: true,
      },
    },
  },
];
