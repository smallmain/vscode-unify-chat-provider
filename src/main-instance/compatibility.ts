import * as vscode from 'vscode';
import { mainInstance } from '.';
import { isVersionIncompatibleError } from './errors';

export async function ensureMainInstanceCompatibility(): Promise<boolean> {
  const error = mainInstance.getCompatibilityError();
  if (!error) {
    return true;
  }

  await vscode.window.showWarningMessage(error.message);
  return false;
}

export async function showMainInstanceCompatibilityWarning(
  error: unknown,
): Promise<boolean> {
  if (!isVersionIncompatibleError(error)) {
    return false;
  }

  await vscode.window.showWarningMessage(error.message);
  return true;
}
