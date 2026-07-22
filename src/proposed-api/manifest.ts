import * as vscode from 'vscode';

const MANIFEST_FILE_NAME = 'package.json';

export class ProposedApiManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposedApiManifestError';
  }
}

export interface ProposedApiManifestSnapshot {
  readonly declared: readonly string[];
  readonly enabled: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringArray(
  value: unknown,
  field: string,
  rejectDuplicates: boolean,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ProposedApiManifestError(`${field} must be an array.`);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ProposedApiManifestError(
        `${field} must contain only non-empty strings.`,
      );
    }
    if (seen.has(item)) {
      if (rejectDuplicates) {
        throw new ProposedApiManifestError(
          `${field} contains duplicate proposal "${item}".`,
        );
      }
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function parseDeclaredApiProposals(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    throw new ProposedApiManifestError('Extension package.json must be an object.');
  }
  return parseStringArray(
    value['enabledApiProposals'],
    'package.json#enabledApiProposals',
    true,
  );
}

export function parseEnabledApiProposals(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    return [];
  }
  const proposals = value['enabledApiProposals'];
  if (proposals === undefined) {
    return [];
  }
  try {
    return parseStringArray(
      proposals,
      'Extension.packageJSON.enabledApiProposals',
      false,
    );
  } catch {
    return [];
  }
}

export async function readProposedApiManifestSnapshot(
  context: vscode.ExtensionContext,
): Promise<ProposedApiManifestSnapshot> {
  const uri = vscode.Uri.joinPath(context.extensionUri, MANIFEST_FILE_NAME);
  let raw: Uint8Array;
  try {
    raw = await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProposedApiManifestError(
      `Unable to read extension package.json: ${message}`,
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProposedApiManifestError(
      `Unable to parse extension package.json: ${message}`,
    );
  }

  const packageJson: unknown = context.extension.packageJSON;
  return {
    declared: parseDeclaredApiProposals(manifest),
    enabled: parseEnabledApiProposals(packageJson),
  };
}
