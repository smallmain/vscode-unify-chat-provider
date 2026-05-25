import {
  PROVIDER_KEYS,
  PROVIDER_TYPES,
  type ProviderType,
} from './client/definitions';

export const LEGACY_LANGUAGE_MODEL_VENDOR_ID = 'unify-chat-provider';

export function getLanguageModelVendorId(providerType: ProviderType): string {
  return `${LEGACY_LANGUAGE_MODEL_VENDOR_ID}.${providerType}`;
}

export function getLanguageModelVendorType(
  vendor: string,
): ProviderType | undefined {
  if (!vendor.startsWith(`${LEGACY_LANGUAGE_MODEL_VENDOR_ID}.`)) {
    return undefined;
  }

  const providerType = vendor.slice(LEGACY_LANGUAGE_MODEL_VENDOR_ID.length + 1);
  return PROVIDER_KEYS.includes(providerType as ProviderType)
    ? (providerType as ProviderType)
    : undefined;
}

export function isUnifyChatProviderVendor(vendor: string): boolean {
  return (
    vendor === LEGACY_LANGUAGE_MODEL_VENDOR_ID ||
    getLanguageModelVendorType(vendor) !== undefined
  );
}

export function getLanguageModelVendorDisplayName(vendor: string): string {
  const providerType = getLanguageModelVendorType(vendor);
  return providerType ? PROVIDER_TYPES[providerType].label : vendor;
}