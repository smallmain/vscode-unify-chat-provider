import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

export type MainInstanceSocketDescriptor =
  | { kind: 'pipe'; path: string }
  | { kind: 'unix'; path: string; filePath: string };

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function computeName(
  extensionId: string,
  machineId: string,
  namespace: string,
): string {
  const hash = sha256Hex(`${extensionId}:${machineId}:${namespace}`).slice(
    0,
    24,
  );
  return `ucp-${hash}`;
}

function pickUnixSocketDir(): string {
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
  namespace: string,
): MainInstanceSocketDescriptor {
  const name = computeName(extensionId, machineId, namespace);
  if (process.platform === 'win32') {
    return { kind: 'pipe', path: `\\\\.\\pipe\\${name}` };
  }

  const dir = pickUnixSocketDir();
  const filePath = path.join(dir, `${name}.sock`);
  return { kind: 'unix', path: filePath, filePath };
}
