import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

export type MainInstanceSocketDescriptor =
  | { kind: 'pipe'; path: string; authTokenPath: string }
  | {
      kind: 'unix';
      path: string;
      filePath: string;
      authTokenPath: string;
    };

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function computeName(
  extensionId: string,
  machineId: string,
  runtimeNamespace: string,
): string {
  // Agents windows use an isolated internal profile. Keep this identity free of
  // profile-scoped paths so every extension host in the same VS Code process
  // participates in one election.
  const hash = sha256Hex(
    `${extensionId}:${machineId}:${runtimeNamespace}`,
  ).slice(0, 24);
  return `ucp-${hash}`;
}

export function getMainInstanceRuntimeNamespace(
  appRoot: string,
  mainProcessId = process.env['VSCODE_PID'],
): string {
  const normalizedAppRoot = path.resolve(appRoot);
  const normalizedMainProcessId = mainProcessId?.trim();
  return normalizedMainProcessId
    ? `${normalizedAppRoot}:process:${normalizedMainProcessId}`
    : `${normalizedAppRoot}:application`;
}

function pickRuntimeDir(): string {
  const dir = os.tmpdir();
  // macOS temp dirs can be long; prefer /tmp for unix sockets to avoid path-length limits.
  if (dir.length > 40 && (process.platform === 'darwin' || process.platform === 'linux')) {
    return '/tmp';
  }
  return dir;
}

export function getMainInstanceSocket(
  extensionId: string,
  machineId: string,
  runtimeNamespace: string,
): MainInstanceSocketDescriptor {
  const name = computeName(extensionId, machineId, runtimeNamespace);
  const dir = pickRuntimeDir();
  const authTokenPath = path.join(dir, `${name}.token`);
  if (process.platform === 'win32') {
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\${name}`,
      authTokenPath,
    };
  }

  const filePath = path.join(dir, `${name}.sock`);
  return { kind: 'unix', path: filePath, filePath, authTokenPath };
}
