import type {
  LanguageModelResponsePart2,
  Progress,
} from 'vscode';
import type { ProviderUsage } from './logger';

type ContextWindowHookModule = typeof import('./context-window-hook');

let loadedContextWindowHookModule: ContextWindowHookModule | null = null;
let loadingContextWindowHookModule:
  | Promise<ContextWindowHookModule | null>
  | undefined;

let reportUsageImpl = (
  _localRequestId: string,
  _usage: ProviderUsage,
): boolean => false;

let reportProgressImpl = (
  _localRequestId: string,
  progress: Progress<LanguageModelResponsePart2>,
  part: LanguageModelResponsePart2,
): void => {
  progress.report(part);
};

let clearRequestImpl = (_localRequestId: string): void => {};

function installNoopImplementations(): void {
  reportUsageImpl = (_localRequestId: string, _usage: ProviderUsage): boolean =>
    false;
  reportProgressImpl = (
    _localRequestId: string,
    progress: Progress<LanguageModelResponsePart2>,
    part: LanguageModelResponsePart2,
  ): void => {
    progress.report(part);
  };
  clearRequestImpl = (_localRequestId: string): void => {};
}

function installHookImplementations(
  hookModule: ContextWindowHookModule,
): void {
  reportUsageImpl = hookModule.reportUsageToContextWindowForRequest;
  reportProgressImpl = hookModule.reportProgressWithContextWindowRequest;
  clearRequestImpl = hookModule.clearContextWindowRequest;
}

async function loadContextWindowHookModule(): Promise<ContextWindowHookModule | null> {
  if (loadedContextWindowHookModule) {
    return loadedContextWindowHookModule;
  }

  if (!loadingContextWindowHookModule) {
    loadingContextWindowHookModule = import('./context-window-hook')
      .then((hookModule) => {
        loadedContextWindowHookModule = hookModule;
        return hookModule;
      })
      .catch(() => {
        loadingContextWindowHookModule = undefined;
        return null;
      });
  }

  const hookModule = await loadingContextWindowHookModule;
  loadingContextWindowHookModule = undefined;
  return hookModule;
}

export function reportUsageToContextWindowForRequest(
  localRequestId: string,
  usage: ProviderUsage,
): boolean {
  return reportUsageImpl(localRequestId, usage);
}

export function reportProgressWithContextWindowRequest(
  localRequestId: string,
  progress: Progress<LanguageModelResponsePart2>,
  part: LanguageModelResponsePart2,
): void {
  reportProgressImpl(localRequestId, progress, part);
}

export function clearContextWindowRequest(localRequestId: string): void {
  clearRequestImpl(localRequestId);
}

export async function initializeContextWindowHookBridge(): Promise<boolean> {
  const hookModule = await loadContextWindowHookModule();
  if (!hookModule) {
    installNoopImplementations();
    return false;
  }

  const success = await hookModule.initializeContextWindowHook();
  if (success) {
    installHookImplementations(hookModule);
  } else {
    installNoopImplementations();
  }

  return success;
}

export async function disposeContextWindowHookBridge(): Promise<boolean> {
  installNoopImplementations();

  if (!loadedContextWindowHookModule) {
    return false;
  }

  return loadedContextWindowHookModule.disposeContextWindowHook();
}

installNoopImplementations();
