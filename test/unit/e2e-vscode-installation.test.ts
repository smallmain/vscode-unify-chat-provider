import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveInstalledVSCode } from '../e2e/vscode-installation';

let root: string;

beforeEach(async () => {
  vi.stubEnv('VSCODE_EXECUTABLE_PATH', '');
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'ucp-vscode-resolver-')));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function executable(relativePath: string): Promise<string> {
  const filename = path.join(root, relativePath);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, '#!/bin/sh\nexit 0\n');
  await chmod(filename, 0o755);
  return filename;
}

describe('installed VS Code resolution', () => {
  it('uses the explicit environment path before automatic candidates', async () => {
    const selected = await executable('custom/Code');
    const other = await executable('other/Code');
    vi.stubEnv('VSCODE_EXECUTABLE_PATH', selected);
    expect(await resolveInstalledVSCode({ candidates: [other] })).toBe(selected);
  });

  it('fails for an invalid override instead of silently choosing another installation', async () => {
    const other = await executable('other/Code');
    await expect(resolveInstalledVSCode({
      executablePath: path.join(root, 'missing'), candidates: [other],
    })).rejects.toThrow('VSCODE_EXECUTABLE_PATH');
  });

  it.each(['Code', 'Electron'])('resolves an installed macOS bundle using %s', async (name) => {
    const selected = await executable(`Visual Studio Code.app/Contents/MacOS/${name}`);
    expect(await resolveInstalledVSCode({
      executablePath: path.join(root, 'Visual Studio Code.app'),
    })).toBe(selected);
  });

  it('resolves a PATH symlink to the native executable in its macOS bundle', async () => {
    const selected = await executable('Code.app/Contents/MacOS/Code');
    const launcher = await executable('Code.app/Contents/Resources/app/bin/code');
    const link = path.join(root, 'code');
    await symlink(launcher, link);
    expect(await resolveInstalledVSCode({ candidates: [link] })).toBe(selected);
  });

  it('skips missing candidates and directories and returns an existing executable', async () => {
    const selected = await executable('installed/code');
    expect(await resolveInstalledVSCode({
      candidates: [path.join(root, 'missing'), root, selected],
    })).toBe(selected);
  });

  it('fails clearly when there is no installation, without a download fallback', async () => {
    await expect(resolveInstalledVSCode({ candidates: [] })).rejects.toThrow(
      'E2E tests do not download or copy VS Code',
    );
  });
});
