import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

function installationCandidates(): string[] {
  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    for (const directory of ['/Applications', path.join(homedir(), 'Applications')]) {
      candidates.push(
        path.join(directory, 'Visual Studio Code.app'),
        path.join(directory, 'Visual Studio Code - Insiders.app'),
      );
    }
  } else if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'];
    const roots = [
      ...(localAppData ? [path.join(localAppData, 'Programs')] : []),
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
    ];
    for (const root of roots) {
      if (!root) continue;
      candidates.push(
        path.join(root, 'Microsoft VS Code', 'Code.exe'),
        path.join(root, 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
      );
    }
  } else {
    candidates.push(
      '/usr/share/code/code',
      '/usr/share/code-insiders/code-insiders',
      '/opt/visual-studio-code/code',
      '/snap/code/current/usr/share/code/code',
    );
  }

  const commands = process.platform === 'win32'
    ? ['code.cmd', 'code-insiders.cmd']
    : ['code', 'code-insiders'];
  for (const directory of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!directory) continue;
    candidates.push(...commands.map((command) => path.join(directory, command)));
  }
  return candidates;
}

async function resolveExecutable(candidate: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(candidate);
    const metadata = await stat(resolved);
    if (metadata.isDirectory() && resolved.endsWith('.app')) {
      for (const name of ['Code', 'Electron']) {
        const executable = await resolveExecutable(
          path.join(resolved, 'Contents', 'MacOS', name),
        );
        if (executable) return executable;
      }
      return undefined;
    }
    if (!metadata.isFile()) return undefined;

    // macOS `code` in PATH is a launcher inside the installed app bundle.
    const cliDirectory = path.join('Contents', 'Resources', 'app', 'bin');
    if (path.dirname(resolved).endsWith(`${path.sep}${cliDirectory}`)) {
      return resolveExecutable(path.resolve(path.dirname(resolved), '../../../..'));
    }

    await access(resolved, constants.X_OK);
    return resolved;
  } catch {
    return undefined;
  }
}

export async function resolveInstalledVSCode(options: {
  executablePath?: string;
  candidates?: readonly string[];
} = {}): Promise<string> {
  const explicit = (options.executablePath ?? process.env['VSCODE_EXECUTABLE_PATH'])?.trim();
  if (explicit) {
    const executable = await resolveExecutable(explicit);
    if (executable) return executable;
    throw new Error(`VSCODE_EXECUTABLE_PATH is not an executable VS Code installation: ${explicit}`);
  }

  for (const candidate of options.candidates ?? installationCandidates()) {
    const executable = await resolveExecutable(candidate);
    if (executable) return executable;
  }
  throw new Error(
    'No installed VS Code found. Set VSCODE_EXECUTABLE_PATH to an existing VS Code executable or macOS .app bundle. E2E tests do not download or copy VS Code.',
  );
}
