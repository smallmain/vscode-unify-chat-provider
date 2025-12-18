import { ModelConfig, ProviderConfig } from '../types';

/**
 * Custom data part mime types used for special markers.
 * These are used to communicate metadata through LanguageModelDataPart.
 */
export namespace DataPartMimeTypes {
  /**
   * Cache control marker for Anthropic prompt caching.
   * When a LanguageModelDataPart with this mimeType is encountered,
   * the previous content block will be marked with cache_control.
   * The data should be 'ephemeral' (as Uint8Array or string).
   */
  export const CacheControl = 'cache_control';

  /**
   * Stateful marker - reserved for internal use.
   */
  export const StatefulMarker = 'stateful_marker';

  /**
   * Thinking data marker - reserved for thinking block metadata.
   */
  export const ThinkingData = 'thinking';
}

export interface ThinkingBlockMetadata {
  /**
   * Signature of the thinking block.
   *
   * VSCode use this.
   */
  signature?: string;

  /**
   * The thinking content (if any).
   *
   * VSCode use this.
   */
  redactedData?: string;

  /**
   * The complete thinking content (if available).
   *
   * VSCode use this.
   */
  _completeThinking?: string;
}

/**
 * `modelid\base64-encoded-raw-data`
 */
export type StatefulMarkerData = `${string}\\${string}`;

export interface Feature {
  /**
   * Supported model familys, use {@link Array.includes} to check if a family is supported.
   */
  supportedFamilys?: string[];

  /**
   * Supported model IDs, use {@link Array.includes} to check if a model is supported.
   */
  supportedModels?: string[];

  /**
   * Supported provider URL patterns.
   * Can be strings with wildcards (*) or RegExp objects.
   * Examples:
   * - "https://api.anthropic.com" - matches https://api.anthropic.com and subpaths
   * - "https://api.anthropic.com/" - matches https://api.anthropic.com/ only (no subpaths)
   * - "https://api.anthropic.com/v1" - matches https://api.anthropic.com/v1 only (no subpaths)
   * - "anthropic.com" - matches any protocol and subpaths
   * - "*.anthropic.com" - wildcard match for subdomains (matches any protocol, subdomains and subpaths)
   * - "https://*.openai.com" - wildcard match (matches subdomains and subpaths)
   * - "*.openai.com" - wildcard match (matches any protocol, subdomains and subpaths)
   * - "https://*.api.anthropic.com" - wildcard match for subdomains (matches subdomains and subpaths)
   * - "https://api.anthropic.com/v1/*" - matches https://api.anthropic.com/v1/foo but not https://sub.api.anthropic.com/v1/foo
   * - /^https:\/\/.*\.azure\.com/ - regex match
   */
  supportedProviders?: ProviderPattern[];

  /**
   * Custom checker functions for feature support.
   * If any checker returns true, the feature is considered supported.
   */
  customCheckers?: FeatureChecker[];
}

/**
 * Pattern for matching provider URLs.
 * Can be a string with wildcards (*) or a RegExp.
 */
export type ProviderPattern = string | RegExp;

/**
 * Custom checker function for feature support.
 * Returns true if the feature should be enabled.
 */
export type FeatureChecker = (
  model: ModelConfig,
  provider: ProviderConfig,
) => boolean;
