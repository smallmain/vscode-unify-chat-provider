import type * as vscode from 'vscode';

function normalizeRelativePath(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  if (
    !normalized ||
    normalized
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    return undefined;
  }
  return normalized;
}

export function relativeWorkspaceUriPath(
  root: Pick<vscode.Uri, 'scheme' | 'authority' | 'path'>,
  target: Pick<vscode.Uri, 'scheme' | 'authority' | 'path'>,
): string | undefined {
  if (root.scheme !== target.scheme || root.authority !== target.authority) {
    return undefined;
  }
  const rootPath = root.path.replace(/\/+$/, '');
  const prefix = `${rootPath}/`;
  if (!target.path.startsWith(prefix)) return undefined;
  return normalizeRelativePath(target.path.slice(prefix.length));
}

export function documentWorkspacePath(
  document: Pick<vscode.TextDocument, 'uri'>,
  folder: Pick<vscode.WorkspaceFolder, 'uri'> | undefined,
): string | undefined {
  return folder
    ? relativeWorkspaceUriPath(folder.uri, document.uri)
    : undefined;
}
