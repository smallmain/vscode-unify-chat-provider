import * as vscode from 'vscode';
import { showInput, pickQuickItem } from '../../../../ui/component';
import { t } from '../../../../i18n';
import { GOOGLE_CLOUD_LOCATIONS } from '../locations';
import type { GoogleVertexAIAdcConfig } from '../../../types';

interface LocationItem extends vscode.QuickPickItem {
  locationId: string;
  isCustom?: boolean;
}

/**
 * Configure ADC (Application Default Credentials) authentication.
 * Requires Project ID and Location input from user.
 */
export async function configureAdc(
  existing?: GoogleVertexAIAdcConfig,
): Promise<GoogleVertexAIAdcConfig | undefined> {
  // Step 1: Project ID (required)
  const projectId = await showInput({
    title: t('Google Cloud Project ID'),
    prompt: t('Enter your Google Cloud Project ID'),
    value: existing?.projectId ?? '',
    placeHolder: t('e.g., my-project-123'),
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) {
        return t('Project ID is required');
      }
      return null;
    },
    onWillAccept: (value) => {
      if (!value.trim()) {
        return false;
      }
      return true;
    },
  });

  if (projectId === undefined) {
    return undefined;
  }

  // Step 2: Location selection (with custom option)
  const location = await selectLocation(existing?.location);
  if (location === undefined) {
    return undefined;
  }

  return {
    method: 'google-vertex-ai-auth',
    subType: 'adc',
    projectId: projectId.trim(),
    location,
  };
}

/**
 * Show a QuickPick to select a Google Cloud location.
 * Includes an option to enter a custom location.
 */
export async function selectLocation(
  currentValue?: string,
): Promise<string | undefined> {
  const items: LocationItem[] = GOOGLE_CLOUD_LOCATIONS.map((loc) => ({
    label: loc.label,
    description: loc.id,
    locationId: loc.id,
    picked: loc.id === currentValue,
  }));

  // Add custom option at the end
  items.push({
    label: `$(edit) ${t('Enter custom location...')}`,
    description: t('Type a custom region/location'),
    locationId: '',
    isCustom: true,
  });

  const selection = await pickQuickItem<LocationItem>({
    title: t('Select Google Cloud Location'),
    placeholder: t('Choose a location for Vertex AI'),
    items,
    ignoreFocusOut: true,
  });

  if (!selection) {
    return undefined;
  }

  if (selection.isCustom) {
    // Show input for custom location
    return await showInput({
      title: t('Custom Location'),
      prompt: t('Enter the Google Cloud location/region'),
      value: currentValue ?? '',
      placeHolder: t('e.g., us-central1'),
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value.trim()) {
          return t('Location is required');
        }
        return null;
      },
      onWillAccept: (value) => {
        if (!value.trim()) {
          return false;
        }
        return true;
      },
    });
  }

  return selection.locationId;
}
