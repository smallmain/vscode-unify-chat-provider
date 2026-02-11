import { GoogleGenAI, type HttpOptions } from '@google/genai';
import * as path from 'node:path';
import * as os from 'node:os';
import { GoogleAIStudioProvider } from './ai-studio-client';
import { ModelConfig, ProviderConfig } from '../../types';
import {
  DEFAULT_NORMAL_TIMEOUT_CONFIG,
  FetchMode,
  resolveChatNetwork,
} from '../../utils';
import type {
  AuthTokenInfo,
  GoogleVertexAIAuthConfig,
  GoogleVertexAIAdcConfig,
  GoogleVertexAIServiceAccountConfig,
} from '../../auth/types';
import { getToken } from '../utils';

/**
 * Vertex AI provider that extends Google AI Studio provider.
 *
 * Supports:
 *
 * 1. New unified auth (google-vertex-ai-auth):
 *    - ADC mode: Uses access token with project/location from auth config
 *    - Service Account mode: Uses access token with project/location from auth config
 *    - API Key mode: Uses global endpoint
 *
 * 2. Legacy api-key auth (for backward compatibility):
 *    - Detected when auth.apiKey is NOT a file path -> API Key mode
 *    - Detected when auth.apiKey IS a file path -> Service Account mode
 *    - Parses project/location from baseUrl
 */
export class VertexAIProvider extends GoogleAIStudioProvider {
  private readonly vertexProject: string | undefined;
  private readonly vertexLocation: string | undefined;
  private readonly vertexBaseDomain: string | undefined;
  private readonly vertexApiVersion: string | undefined;

  constructor(config: ProviderConfig) {
    super(config);

    this.vertexApiVersion = this.parseApiVersionFromUrl(config.baseUrl);

    // Parse project and location from baseUrl
    // Expected format: https://{location}-aiplatform.googleapis.com/{version}/projects/{project}/locations/{location}
    const parsed = this.parseVertexUrl(config.baseUrl);
    this.vertexProject = parsed.project;
    this.vertexLocation = parsed.location;
    this.vertexBaseDomain = parsed.baseDomain;
  }

  private parseApiVersionFromUrl(baseUrl: string): string | undefined {
    try {
      const url = new URL(baseUrl);
      const pathname = url.pathname.replace(/\/+$/, '');

      const endMatch = pathname.match(/\/(v\d+(?:alpha|beta)?\d*)$/i);
      if (endMatch) return endMatch[1];

      const startMatch = pathname.match(/^\/(v\d+(?:alpha|beta)?\d*)(?:\/|$)/i);
      if (startMatch) return startMatch[1];
    } catch {
      // ignore invalid URL
    }

    return undefined;
  }

  /**
   * Parse project, location, and base domain from Vertex AI URL.
   *
   * Expected format:
   * https://{location}-aiplatform.googleapis.com/{version}/projects/{project}/locations/{location}
   */
  private parseVertexUrl(baseUrl: string): {
    project?: string;
    location?: string;
    baseDomain?: string;
  } {
    try {
      const url = new URL(baseUrl);
      // Match: /projects/{project}/locations/{location}
      const match = url.pathname.match(
        /\/projects\/([^/]+)\/locations\/([^/]+)/,
      );
      if (match) {
        return {
          project: match[1],
          location: match[2],
          baseDomain: url.origin,
        };
      }
    } catch {
      // Invalid URL
    }
    return {};
  }

  /**
   * Detects whether the apiKey is a file path (service account) or an API key.
   *
   * File path detection:
   * - Ends with .json
   * - Is an absolute path
   * - Starts with ~/ (home directory)
   * - Starts with ./ (relative path)
   * - File exists and is readable
   */
  private detectAuthMethod(apiKey: string | undefined): {
    isServiceAccount: boolean;
    filePath?: string;
  } {
    if (!apiKey) {
      return { isServiceAccount: false };
    }

    const trimmed = apiKey.trim();

    // Check if it looks like a file path
    if (
      trimmed.endsWith('.json') ||
      path.isAbsolute(trimmed) ||
      trimmed.startsWith('~/') ||
      trimmed.startsWith('./')
    ) {
      // Resolve the path
      let resolvedPath = trimmed;
      if (trimmed.startsWith('~/')) {
        resolvedPath = path.join(os.homedir(), trimmed.slice(2));
      }
      return { isServiceAccount: true, filePath: resolvedPath };
    }

    return { isServiceAccount: false };
  }

  protected override createClient(
    modelConfig: ModelConfig | undefined,
    streamEnabled: boolean,
    credential?: AuthTokenInfo,
    mode: FetchMode = 'chat',
  ): GoogleGenAI {
    const chatNetwork =
      mode === 'chat' ? resolveChatNetwork(this.config) : undefined;
    const effectiveTimeout =
      chatNetwork?.timeout ?? DEFAULT_NORMAL_TIMEOUT_CONFIG;

    const requestTimeoutMs = streamEnabled
      ? effectiveTimeout.connection
      : effectiveTimeout.response;

    const token = getToken(credential);
    const auth = this.config.auth;

    // Check for new unified Vertex AI auth
    if (auth?.method === 'google-vertex-ai-auth') {
      return this.createClientWithNewAuth(
        auth as GoogleVertexAIAuthConfig,
        token,
        modelConfig,
        requestTimeoutMs,
        credential,
      );
    }

    // Legacy mode: detect from token value
    return this.createClientWithLegacyAuth(
      token,
      modelConfig,
      requestTimeoutMs,
      credential,
    );
  }

  /**
   * Create client using new google-vertex-ai-auth configuration.
   * Authentication is handled by the SDK internally.
   */
  private createClientWithNewAuth(
    auth: GoogleVertexAIAuthConfig,
    token: string | undefined,
    modelConfig: ModelConfig | undefined,
    requestTimeoutMs: number,
    credential?: AuthTokenInfo,
  ): GoogleGenAI {
    if (auth.subType === 'adc') {
      // ADC mode: SDK automatically uses Application Default Credentials
      const adcConfig = auth as GoogleVertexAIAdcConfig;
      const baseUrl = `https://${adcConfig.location}-aiplatform.googleapis.com`;

      const httpOptions: HttpOptions = {
        baseUrl,
        headers: this.buildHeaders(credential, modelConfig),
        timeout: requestTimeoutMs,
        extraBody: this.buildExtraBody(modelConfig),
      };

      return new GoogleGenAI({
        vertexai: true,
        project: adcConfig.projectId,
        location: adcConfig.location,
        apiVersion: this.vertexApiVersion,
        httpOptions,
      });
    }

    if (auth.subType === 'service-account') {
      // Service Account mode: SDK uses keyFilename for authentication
      const saConfig = auth as GoogleVertexAIServiceAccountConfig;
      const baseUrl = `https://${saConfig.location}-aiplatform.googleapis.com`;

      const httpOptions: HttpOptions = {
        baseUrl,
        headers: this.buildHeaders(credential, modelConfig),
        timeout: requestTimeoutMs,
        extraBody: this.buildExtraBody(modelConfig),
      };

      return new GoogleGenAI({
        vertexai: true,
        project: saConfig.projectId,
        location: saConfig.location,
        googleAuthOptions: {
          keyFilename: saConfig.keyFilePath,
        },
        apiVersion: this.vertexApiVersion,
        httpOptions,
      });
    }

    // API Key mode (express mode) - uses global endpoint
    const httpOptions: HttpOptions = {
      baseUrl: 'https://aiplatform.googleapis.com',
      headers: this.buildHeaders(credential, modelConfig),
      timeout: requestTimeoutMs,
      extraBody: this.buildExtraBody(modelConfig),
    };

    return new GoogleGenAI({
      vertexai: true,
      apiKey: token,
      apiVersion: this.vertexApiVersion,
      httpOptions,
    });
  }

  /**
   * Create client using legacy api-key auth configuration.
   * Maintains backward compatibility with existing configurations.
   */
  private createClientWithLegacyAuth(
    token: string | undefined,
    modelConfig: ModelConfig | undefined,
    requestTimeoutMs: number,
    credential?: AuthTokenInfo,
  ): GoogleGenAI {
    const detected = this.detectAuthMethod(token);

    // Use the base domain (without path) for httpOptions.baseUrl
    // The SDK will construct the full URL using project/location
    const httpOptions: HttpOptions = {
      baseUrl: this.vertexBaseDomain ?? this.baseUrl,
      headers: this.buildHeaders(credential, modelConfig),
      timeout: requestTimeoutMs,
      extraBody: this.buildExtraBody(modelConfig),
    };

    if (detected.isServiceAccount && detected.filePath) {
      // Service account JSON key authentication (standard mode)
      return new GoogleGenAI({
        vertexai: true,
        project: this.vertexProject,
        location: this.vertexLocation,
        googleAuthOptions: {
          keyFilename: detected.filePath,
        },
        apiVersion: this.vertexApiVersion,
        httpOptions,
      });
    } else if (token) {
      // Google Cloud API key authentication (express mode)
      return new GoogleGenAI({
        vertexai: true,
        apiKey: token,
        apiVersion: this.vertexApiVersion,
        httpOptions,
      });
    } else {
      // Application Default Credentials (ADC)
      return new GoogleGenAI({
        vertexai: true,
        project: this.vertexProject,
        location: this.vertexLocation,
        apiVersion: this.vertexApiVersion,
        httpOptions,
      });
    }
  }
}
