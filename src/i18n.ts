import * as vscode from 'vscode';

/**
 * Shorthand for vscode.l10n.t - translates the given message.
 */
export const t = vscode.l10n.t;

export function isEnglish(): boolean {
  const lang = vscode.env.language?.toLowerCase() ?? '';
  return lang === 'en' || lang.startsWith('en-') || lang.startsWith('en_');
}
