import { ApiType } from './client/definitions';

/**
 * Default API type when not specified
 */
export const DEFAULT_PROVIDER_TYPE: ApiType = 'openai-chat-completion';

/**
 * Default token limits for models
 */
export const DEFAULT_MAX_INPUT_TOKENS = 128000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 64000;
