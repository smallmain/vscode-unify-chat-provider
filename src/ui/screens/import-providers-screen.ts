import * as vscode from 'vscode';
import {
  getProviderMigrationSource,
  importProvidersFromConfigFile,
  normalizeConfigFilePathInput,
  PROVIDER_MIGRATION_SOURCES,
} from '../../migration';
import type {
  ProviderMigrationCandidate,
  ProviderMigrationSource,
} from '../../migration';
import type { ProviderConfig } from '../../types';
import { pickQuickItem, showInput } from '../component';
import { validateProviderNameUnique } from '../form-utils';
import type {
  ImportProvidersRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import { promises as fs } from 'fs';

type SourcePickItem = vscode.QuickPickItem & {
  sourceId: string;
  detectedPath?: string;
};

type CandidatePickItem = vscode.QuickPickItem & {
  initialConfig: Partial<ProviderConfig>;
};

const browseButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('folder-opened'),
  tooltip: 'Browse...',
};

const customPathButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('folder-opened'),
  tooltip: 'Custom path...',
};

const importFromContentButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('file-code'),
  tooltip: 'Import from config content',
};

type SourceItemAction =
  | { kind: 'customPath'; item: SourcePickItem }
  | { kind: 'configContent'; item: SourcePickItem };

export async function runImportProvidersScreen(
  ctx: UiContext,
  _route: ImportProvidersRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const items = await buildSourceItems();
  if (items.length === 0) {
    vscode.window.showInformationMessage(
      'No supported applications are available for import yet.',
    );
    return { kind: 'pop' };
  }

  let itemAction: SourceItemAction | undefined;

  const selection = await pickQuickItem<SourcePickItem>({
    title: 'Import Providers From Other Applications',
    placeholder: 'Select an application to import from',
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: false,
    items,
    onDidTriggerItemButton: (event, qp) => {
      if (event.button === customPathButton) {
        itemAction = { kind: 'customPath', item: event.item };
        qp.hide();
        return;
      }
      if (event.button === importFromContentButton) {
        itemAction = { kind: 'configContent', item: event.item };
        qp.hide();
      }
    },
  });

  if (itemAction) {
    return handleSourceItemAction(ctx, itemAction);
  }

  if (!selection) return { kind: 'pop' };

  const source = getProviderMigrationSource(selection.sourceId);
  if (!source) {
    vscode.window.showErrorMessage(
      `Import source "${selection.sourceId}" not found.`,
    );
    return { kind: 'stay' };
  }

  const configFilePath =
    selection.detectedPath ??
    (await promptForConfigFilePath(source.displayName));
  if (!configFilePath) return { kind: 'stay' };

  return importProvidersFromPath(ctx, source, configFilePath);
}

async function buildSourceItems(): Promise<SourcePickItem[]> {
  const results = await Promise.all(
    PROVIDER_MIGRATION_SOURCES.map(async (source) => ({
      source,
      detectedPath: await source.detectConfigFile(),
    })),
  );

  return results.map(({ source, detectedPath }) => ({
    label: source.displayName,
    sourceId: source.id,
    detectedPath,
    detail: detectedPath
      ? `Detected config file: ${detectedPath}`
      : 'Config file not detected. You can locate it manually.',
    buttons: [customPathButton, importFromContentButton],
  }));
}

async function promptForConfigFilePath(
  appName: string,
  defaultValue?: string,
): Promise<string | undefined> {
  const inputBox = vscode.window.createInputBox();
  inputBox.title = 'Import Providers From Other Applications';
  inputBox.prompt = `Enter ${appName} config file path`;
  inputBox.placeholder = 'Path to config file...';
  inputBox.ignoreFocusOut = true;
  inputBox.buttons = [browseButton];
  inputBox.value = defaultValue ?? '';

  let resolved = false;

  return new Promise<string | undefined>((resolve) => {
    const finish = (value: string | undefined) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    inputBox.onDidTriggerButton(async (button) => {
      if (button !== browseButton) return;
      const selection = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Select config file',
        title: `Select ${appName} config file`,
      });
      const uri = selection?.[0];
      if (uri) {
        inputBox.value = uri.fsPath;
        inputBox.validationMessage = undefined;
      }
    });

    inputBox.onDidAccept(async () => {
      const rawPath = inputBox.value.trim();
      if (!rawPath) {
        inputBox.validationMessage = 'Config file path is required';
        return;
      }

      const normalized = normalizeConfigFilePathInput(rawPath);
      try {
        const stat = await fs.stat(normalized);
        if (!stat.isFile()) {
          inputBox.validationMessage = 'Please select a file path';
          return;
        }
      } catch {
        inputBox.validationMessage = 'File not found';
        return;
      }

      finish(normalized);
      inputBox.hide();
    });

    inputBox.onDidHide(() => {
      finish(undefined);
      inputBox.dispose();
    });

    inputBox.show();
  });
}

async function promptForConfigContent(
  appName: string,
): Promise<string | undefined> {
  const clipboardText = await readClipboardText();

  const inputBox = vscode.window.createInputBox();
  inputBox.title = 'Import Providers From Other Applications';
  inputBox.prompt = `Paste ${appName} config content`;
  inputBox.placeholder = 'Configuration content...';
  inputBox.ignoreFocusOut = true;

  if (clipboardText) {
    inputBox.value = clipboardText;
  }

  let resolved = false;

  return new Promise<string | undefined>((resolve) => {
    const finish = (value: string | undefined) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    inputBox.onDidChangeValue((text) => {
      if (!text.trim()) {
        inputBox.validationMessage = 'Config content is required';
      } else {
        inputBox.validationMessage = undefined;
      }
    });

    inputBox.onDidAccept(() => {
      const rawContent = inputBox.value.trim();
      if (!rawContent) {
        inputBox.validationMessage = 'Config content is required';
        return;
      }

      finish(rawContent);
      inputBox.hide();
    });

    inputBox.onDidHide(() => {
      finish(undefined);
      inputBox.dispose();
    });

    inputBox.show();
  });
}

async function readClipboardText(): Promise<string | undefined> {
  try {
    const clipboardText = await vscode.env.clipboard.readText();
    const trimmed = clipboardText.trim();
    if (!trimmed || trimmed.length > 100000) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

async function pickCandidateInitialConfig(
  candidates: readonly ProviderMigrationCandidate[],
): Promise<Partial<ProviderConfig> | undefined> {
  if (candidates.length === 1) return candidates[0].provider;

  const items: CandidatePickItem[] = candidates.map((candidate, index) => {
    const provider = candidate.provider;
    return {
      label: provider.name || `Provider ${index + 1}`,
      initialConfig: provider,
    };
  });

  const selection = await pickQuickItem<CandidatePickItem>({
    title: `Import ${candidates.length} Providers`,
    placeholder: 'Select a provider to review before saving',
    ignoreFocusOut: false,
    items,
  });

  return selection?.initialConfig;
}

async function handleSourceItemAction(
  ctx: UiContext,
  action: SourceItemAction,
): Promise<UiNavAction> {
  const source = getProviderMigrationSource(action.item.sourceId);
  if (!source) {
    vscode.window.showErrorMessage(
      `Import source "${action.item.sourceId}" not found.`,
    );
    return { kind: 'stay' };
  }

  if (action.kind === 'customPath') {
    const configFilePath = await promptForConfigFilePath(
      source.displayName,
      action.item.detectedPath,
    );
    if (!configFilePath) return { kind: 'stay' };
    return importProvidersFromPath(ctx, source, configFilePath);
  }

  const configContent = await promptForConfigContent(source.displayName);
  if (!configContent) return { kind: 'stay' };
  return importProvidersFromContent(ctx, source, configContent);
}

async function importProvidersFromContent(
  ctx: UiContext,
  source: ProviderMigrationSource,
  content: string,
): Promise<UiNavAction> {
  try {
    const candidates = await source.importFromConfigContent(content);
    return handleImportCandidates(ctx, source.displayName, candidates);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(
      `Failed to import from ${source.displayName}: ${message}`,
      { modal: true },
    );
    return { kind: 'stay' };
  }
}

async function importProvidersFromPath(
  ctx: UiContext,
  source: ProviderMigrationSource,
  configFilePath: string,
): Promise<UiNavAction> {
  try {
    const candidates = await importProvidersFromConfigFile({
      source,
      configFilePath,
    });
    return handleImportCandidates(ctx, source.displayName, candidates);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(
      `Failed to import from ${source.displayName}: ${message}`,
      { modal: true },
    );
    return { kind: 'stay' };
  }
}

async function handleImportCandidates(
  ctx: UiContext,
  sourceName: string,
  candidates: readonly ProviderMigrationCandidate[],
): Promise<UiNavAction> {
  if (candidates.length === 0) {
    vscode.window.showErrorMessage(
      `No providers found in ${sourceName} configuration.`,
    );
    return { kind: 'stay' };
  }

  const initialConfig = await pickCandidateInitialConfig(candidates);
  if (!initialConfig) return { kind: 'stay' };

  const suggestedName = (initialConfig.name ?? sourceName).trim();
  if (validateProviderNameUnique(suggestedName, ctx.store) !== null) {
    const name = await showInput({
      title: 'Provider Name',
      prompt: 'Enter a name for this provider',
      value: suggestedName,
      placeHolder: 'e.g., My Provider, OpenRouter, Custom',
      ignoreFocusOut: true,
      showBackButton: true,
      validateInput: (value) => validateProviderNameUnique(value, ctx.store),
    });
    if (name === undefined) return { kind: 'pop' };
    initialConfig.name = name.trim();
  } else {
    initialConfig.name = suggestedName;
  }

  return {
    kind: 'replace',
    route: { kind: 'providerForm', initialConfig },
  };
}
