import { buildBaseUrl } from '../../client/utils';
import { normalizeBaseUrlInput } from '../../utils';
import type { NativeCompletionApiContext } from './provider';

type BuildBaseUrlOptions = NonNullable<Parameters<typeof buildBaseUrl>[1]>;

const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;

export function buildCompletionBaseUrl(
  context: NativeCompletionApiContext,
  options?: BuildBaseUrlOptions,
): string {
  const configured = context.completion.baseUrl;
  if (configured === undefined || URL_SCHEME.test(configured)) {
    return buildBaseUrl(configured ?? context.provider.baseUrl, options);
  }

  const providerBaseUrl = buildBaseUrl(context.provider.baseUrl, options);
  return normalizeBaseUrlInput(
    new URL(configured, `${providerBaseUrl.replace(/\/+$/, '')}/`).toString(),
  );
}
