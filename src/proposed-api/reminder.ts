import * as vscode from 'vscode';
import { t } from '../i18n';
import { authLog } from '../logger';
import {
  createProposedApiCapabilities,
  type ProposedApiCapabilities,
} from './capabilities';
import { readProposedApiManifestSnapshot } from './manifest';
import {
  createProductJsonEnvironment,
  inspectProductJson,
  ProductJsonError,
  type ProductJsonInspection,
  writeProductJsonProposals,
} from './product-json';
import { canUseLanguageModelThinkingPart } from './thinking';

export const PROPOSED_API_REMINDER_VERSION = 1;

const DISMISSED_REMINDER_VERSION_KEY =
  'proposedApi.dismissedReminderVersion';
const ENABLE_COMMAND = 'unifyChatProvider.enableProposedApi';
const QUIT_COMMAND = 'workbench.action.quit';

let startupReminderScheduled = false;
let enableOperation: Promise<void> | undefined;

type PurposeFactory = () => string;

export function isProposedApiReminderDue(
  dismissedVersion: number,
  currentVersion = PROPOSED_API_REMINDER_VERSION,
): boolean {
  return dismissedVersion < currentVersion;
}

const proposalPurposeFactories: Readonly<Record<string, PurposeFactory>> =
  Object.freeze({
    languageModelSystem: () =>
      t(
        'Disabling it reduces the quality of generated commit messages and code predictions.',
      ),
    chatProvider: () =>
      t(
        'Disabling it removes per-model settings and enhanced model selection.',
      ),
    inlineCompletionsAdditions: () =>
      t('Disabling it makes code completion unavailable.'),
    contribSourceControlInputBoxMenu: () =>
      t(
        'When disabled, the commit-message button moves to the Source Control title bar.',
      ),
    languageModelThinkingPart: () =>
      t('Disabling it hides model thinking/reasoning content.'),
  });

export function hasProposedApiPurpose(proposal: string): boolean {
  return proposalPurposeFactories[proposal] !== undefined;
}

export function getProposedApiPurpose(proposal: string): string {
  return (
    proposalPurposeFactories[proposal]?.() ??
    t('A Proposed API declared by this extension.')
  );
}

function buildProposedApiConsentDetail(): string {
  return [
    t(
      'Do you agree to enable the features above by modifying product.json in the current VS Code installation (administrator permission is required)?',
    ),
    t(
      'The extension will still work without them, but it will not provide the best experience.',
    ),
  ].join('\n');
}

function readDismissedReminderVersion(
  context: vscode.ExtensionContext,
): number {
  const value: unknown = context.globalState.get(DISMISSED_REMINDER_VERSION_KEY);
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

export function buildProposedApiReminderDetail(
  capabilities: ProposedApiCapabilities,
): string {
  const proposalLines = capabilities.declared.map(
    (proposal) => `- ${proposal}: ${getProposedApiPurpose(proposal)}`,
  );
  return [
    t('This extension uses the following Proposed APIs:'),
    '',
    ...proposalLines,
    '',
    buildProposedApiConsentDetail(),
  ].join('\n');
}

async function showManualExitMessage(): Promise<void> {
  await vscode.window.showInformationMessage(
    t(
      'Please completely quit all VS Code windows and start VS Code again to activate the Proposed APIs.',
    ),
  );
}

async function quitVsCode(): Promise<void> {
  try {
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes(QUIT_COMMAND)) {
      await showManualExitMessage();
      return;
    }
    await vscode.commands.executeCommand(QUIT_COMMAND);
  } catch (error) {
    authLog.error(
      'proposed-api',
      'The internal VS Code quit command was unavailable',
      error,
    );
    await showManualExitMessage();
  }
}

async function promptForRestart(): Promise<void> {
  const quit = t('Quit VS Code');
  const later = t('Later');
  const selection = await vscode.window.showInformationMessage(
    t('A complete VS Code restart is required for the Proposed API configuration.'),
    {
      modal: true,
      detail: t(
        'The change only takes effect after every VS Code window is completely closed and VS Code is started again. Reload Window is not sufficient.',
      ),
    },
    quit,
    later,
  );
  if (selection === quit) {
    await quitVsCode();
  }
}

function productErrorMessage(error: ProductJsonError): string {
  switch (error.code) {
    case 'unsupported-web':
      return t(
        'This Web extension host cannot modify a desktop VS Code installation. Use a local desktop window or enable the Proposed APIs manually.',
      );
    case 'unsupported-remote':
      return t(
        'This is a remote extension host. Open a local VS Code window to enable the Proposed APIs; the remote product.json is not the correct target.',
      );
    case 'unsupported-platform':
      return t(
        'Automatic Proposed API enablement is supported only on Windows, macOS, and Linux desktop installations.',
      );
    case 'invalid-app-root':
    case 'invalid-product':
      return t(
        'The current VS Code installation could not be verified safely. No files were changed. Enable the Proposed APIs manually or use the --enable-proposed-api startup option.',
      );
    case 'invalid-manifest':
      return t(
        'The extension Proposed API manifest is invalid. No files were changed.',
      );
    case 'concurrent-change':
      return t(
        'VS Code product.json changed during the operation, so it was not overwritten. Try again after the update or other modification finishes.',
      );
    case 'read-only':
      return t(
        'The VS Code installation is read-only. Enable the Proposed APIs manually using a supported installation or startup option.',
      );
    case 'cancelled':
      return t('Administrator authorization was cancelled. No change was applied.');
    case 'verification-failed':
      return t(
        'The product.json write could not be verified. Restore the backup if necessary and enable the Proposed APIs manually.',
      );
    case 'write-failed':
      return t(
        'VS Code product.json could not be updated. No successful change was recorded.',
      );
  }
}

async function showProductError(error: unknown): Promise<void> {
  if (error instanceof ProductJsonError) {
    const message = productErrorMessage(error);
    if (error.code === 'cancelled') {
      await vscode.window.showInformationMessage(message);
    } else {
      await vscode.window.showErrorMessage(message);
    }
    return;
  }
  authLog.error(
    'proposed-api',
    'Unexpected error while enabling Proposed APIs',
    error,
  );
  await vscode.window.showErrorMessage(
    t('An unexpected error occurred while enabling the Proposed APIs.'),
  );
}

async function confirmProductModification(): Promise<boolean> {
  const enable: vscode.MessageItem = {
    title: t('Enable'),
  };
  const cancel: vscode.MessageItem = {
    title: t('Cancel'),
    isCloseAffordance: true,
  };
  const selection = await vscode.window.showWarningMessage(
    t('Enable Proposed APIs for Unify Chat Provider?'),
    {
      modal: true,
      detail: buildProposedApiConsentDetail(),
    },
    enable,
    cancel,
  );
  return selection === enable;
}

async function runEnableOperation(
  context: vscode.ExtensionContext,
  capabilities: ProposedApiCapabilities,
  alreadyConfirmed: boolean,
): Promise<void> {
  const environment = createProductJsonEnvironment(context);
  let inspection: ProductJsonInspection;
  try {
    inspection = await inspectProductJson(environment, capabilities.declared);
  } catch (error) {
    await showProductError(error);
    return;
  }

  if (inspection.configured) {
    if (capabilities.missing.length === 0) {
      await vscode.window.showInformationMessage(
        t('All declared Proposed APIs are enabled in the current VS Code session.'),
      );
    } else {
      await promptForRestart();
    }
    return;
  }

  if (!alreadyConfirmed && !(await confirmProductModification())) {
    return;
  }

  try {
    const result = await writeProductJsonProposals(
      environment,
      capabilities.declared,
    );
    if (result.configured) {
      await promptForRestart();
    }
  } catch (error) {
    await showProductError(error);
  }
}

function enableProposedApis(
  context: vscode.ExtensionContext,
  capabilities: ProposedApiCapabilities,
  alreadyConfirmed: boolean,
): Promise<void> {
  enableOperation ??= runEnableOperation(
    context,
    capabilities,
    alreadyConfirmed,
  ).finally(() => {
    enableOperation = undefined;
  });
  return enableOperation;
}

async function readCurrentCapabilities(
  context: vscode.ExtensionContext,
): Promise<ProposedApiCapabilities> {
  return createProposedApiCapabilities(
    await readProposedApiManifestSnapshot(context),
    { canUseLanguageModelThinkingPart },
  );
}

export function registerProposedApiEnableCommand(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(ENABLE_COMMAND, async () => {
      let capabilities: ProposedApiCapabilities;
      try {
        capabilities = await readCurrentCapabilities(context);
      } catch (error) {
        authLog.error(
          'proposed-api',
          'Unable to read the Proposed API manifest for the manual command',
          error,
        );
        await vscode.window.showErrorMessage(
          t(
            'The extension Proposed API manifest is invalid. No files were changed.',
          ),
        );
        return;
      }
      await enableProposedApis(context, capabilities, false);
    }),
  );
}

async function showStartupReminder(
  context: vscode.ExtensionContext,
  capabilities: ProposedApiCapabilities,
): Promise<void> {
  const [enable, never, later] = createProposedApiReminderItems();
  const selection = await vscode.window.showWarningMessage(
    t('Enable all Unify Chat Provider features?'),
    { modal: true, detail: buildProposedApiReminderDetail(capabilities) },
    enable,
    never,
    later,
  );
  if (selection === never) {
    await context.globalState.update(
      DISMISSED_REMINDER_VERSION_KEY,
      PROPOSED_API_REMINDER_VERSION,
    );
    return;
  }
  if (selection === enable) {
    await enableProposedApis(context, capabilities, true);
  }
}

export function createProposedApiReminderItems(): readonly [
  vscode.MessageItem,
  vscode.MessageItem,
  vscode.MessageItem,
] {
  return [
    { title: t('Enable') },
    { title: t('Never Remind Again') },
    { title: t('Later'), isCloseAffordance: true },
  ];
}

export function scheduleProposedApiStartupReminder(
  context: vscode.ExtensionContext,
  capabilities: ProposedApiCapabilities,
): void {
  if (
    startupReminderScheduled ||
    capabilities.missing.length === 0 ||
    !isProposedApiReminderDue(readDismissedReminderVersion(context))
  ) {
    return;
  }
  startupReminderScheduled = true;
  const timer = setTimeout(() => {
    void showStartupReminder(context, capabilities).catch((error) => {
      authLog.error(
        'proposed-api',
        'Unable to show the Proposed API startup reminder',
        error,
      );
    });
  }, 0);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      clearTimeout(timer);
    }),
  );
}
