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
import { ClaudeCodeOAuthDetectedError } from '../../migration/errors';
import type { ProviderConfig } from '../../types';
import { pickQuickItem, showInput } from '../component';
import { createProviderDraft, validateProviderNameUnique } from '../form-utils';
import type {
  ImportProvidersRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import { migrationLog } from '../../logger';
import { promises as fs } from 'fs';
import { t } from '../../i18n';
import { WELL_KNOWN_PROVIDERS } from '../../well-known/providers';

type SourcePickItem = vscode.QuickPickItem & {
  sourceId: string;
  detectedPath?: string;
};

type CandidatePickItem = vscode.QuickPickItem & {
  initialConfig: Partial<ProviderConfig>;
};

const browseButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('folder-opened'),
  tooltip: t('Browse...'),
};

const customPathButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('folder-opened'),
  tooltip: t('Custom path...'),
};

const importFromContentButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('file-code'),
  tooltip: t('Import from config content'),
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
      t('No supported applications are available for import yet.'),
    );
    return { kind: 'pop' };
  }

  let itemAction: SourceItemAction | undefined;

  const selection = await pickQuickItem<SourcePickItem>({
    title: t('Import Providers From Other Applications'),
    placeholder: t('Select an application to import from'),
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
      t('Import source "{0}" not found.', selection.sourceId),
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
      ? t('Detected config file: {0}', detectedPath)
      : t('Config file not detected. You can locate it manually.'),
    buttons: [customPathButton, importFromContentButton],
  }));
}

async function promptForConfigFilePath(
  appName: string,
  defaultValue?: string,
): Promise<string | undefined> {
  const inputBox = vscode.window.createInputBox();
  inputBox.title = t('Import Providers From Other Applications');
  inputBox.prompt = t('Enter {0} config file path', appName);
  inputBox.placeholder = t('Path to config file...');
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
        openLabel: t('Select config file'),
        title: t('Select {0} config file', appName),
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
        inputBox.validationMessage = t('Config file path is required');
        return;
      }

      const normalized = normalizeConfigFilePathInput(rawPath);
      try {
        const stat = await fs.stat(normalized);
        if (!stat.isFile()) {
          inputBox.validationMessage = t('Please select a file path');
          return;
        }
      } catch {
        inputBox.validationMessage = t('File not found');
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
  inputBox.title = t('Import Providers From Other Applications');
  inputBox.prompt = t('Paste {0} config content', appName);
  inputBox.placeholder = t('Configuration content...');
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
        inputBox.validationMessage = t('Config content is required');
      } else {
        inputBox.validationMessage = undefined;
      }
    });

    inputBox.onDidAccept(() => {
      const rawContent = inputBox.value.trim();
      if (!rawContent) {
        inputBox.validationMessage = t('Config content is required');
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
      label: provider.name || t('Provider {0}', index + 1),
      initialConfig: provider,
    };
  });

  const selection = await pickQuickItem<CandidatePickItem>({
    title: t('Import {0} Providers', candidates.length),
    placeholder: t('Select a provider to review before saving'),
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
      t('Import source "{0}" not found.', action.item.sourceId),
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
    migrationLog.info(source.id, 'Importing from pasted content');
    migrationLog.info(source.id, 'Config content', content);
    const candidates = await source.importFromConfigContent(content);
    return handleImportCandidates(ctx, source.displayName, candidates);
  } catch (error) {
    if (error instanceof ClaudeCodeOAuthDetectedError) {
      return handleClaudeCodeOAuthDetected(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(
      t('Failed to import from {0}: {1}', source.displayName, message),
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
    if (error instanceof ClaudeCodeOAuthDetectedError) {
      return handleClaudeCodeOAuthDetected(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(
      t('Failed to import from {0}: {1}', source.displayName, message),
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
      t('No providers found in {0} configuration.', sourceName),
    );
    return { kind: 'stay' };
  }

  const initialConfig = await pickCandidateInitialConfig(candidates);
  if (!initialConfig) return { kind: 'stay' };

  const suggestedName = (initialConfig.name ?? sourceName).trim();
  if (validateProviderNameUnique(suggestedName, ctx.store) !== null) {
    const name = await showInput({
      title: t('Provider Name'),
      prompt: t('Enter a name for this provider'),
      value: suggestedName,
      placeHolder: t('e.g., My Provider, OpenRouter, Custom'),
      ignoreFocusOut: true,
      showBackButton: true,
      validateInput: (value) => validateProviderNameUnique(value, ctx.store),
      onWillAccept: (value) => {
        if (!value.trim()) {
          return false;
        }
        return true;
      },
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

function handleClaudeCodeOAuthDetected(
  error: ClaudeCodeOAuthDetectedError,
): UiNavAction {
  const claudeCodeProvider = WELL_KNOWN_PROVIDERS.find(
    (p) => p.type === 'claude-code',
  );

  if (!claudeCodeProvider) {
    vscode.window.showErrorMessage(
      t('Claude Code provider not found in well-known providers.'),
      { modal: true },
    );
    return { kind: 'stay' };
  }

  const emailInfo = error.email ? ` (${error.email})` : '';
  vscode.window.showInformationMessage(
    t(
      'Claude Code OAuth detected{0}. Please re-authenticate.',
      emailInfo,
    ),
  );

  const draft = createProviderDraft();
  draft.type = claudeCodeProvider.type;
  draft.name = claudeCodeProvider.name;
  draft.baseUrl = claudeCodeProvider.baseUrl;

  return {
    kind: 'replace',
    route: {
      kind: 'wellKnownProviderAuth',
      provider: claudeCodeProvider,
      draft,
    },
  };
}
