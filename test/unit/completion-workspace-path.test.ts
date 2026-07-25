import { describe, expect, it } from 'vitest';
import { relativeWorkspaceUriPath } from '../../src/completion/edit/workspace-path';

function uri(scheme: string, authority: string, path: string) {
  return { scheme, authority, path };
}

describe('edit-prediction workspace paths', () => {
  it('resolves local and remote workspace-relative paths', () => {
    expect(
      relativeWorkspaceUriPath(
        uri('file', '', '/workspace'),
        uri('file', '', '/workspace/src/main.ts'),
      ),
    ).toBe('src/main.ts');
    expect(
      relativeWorkspaceUriPath(
        uri('vscode-remote', 'ssh-remote+host', '/workspace'),
        uri(
          'vscode-remote',
          'ssh-remote+host',
          '/workspace/src/main.ts',
        ),
      ),
    ).toBe('src/main.ts');
  });

  it('rejects other authorities, sibling roots, and unsafe segments', () => {
    const root = uri('vscode-remote', 'ssh-remote+host', '/workspace');
    expect(
      relativeWorkspaceUriPath(
        root,
        uri('vscode-remote', 'ssh-remote+other', '/workspace/main.ts'),
      ),
    ).toBeUndefined();
    expect(
      relativeWorkspaceUriPath(
        root,
        uri('vscode-remote', 'ssh-remote+host', '/workspace-two/main.ts'),
      ),
    ).toBeUndefined();
    expect(
      relativeWorkspaceUriPath(
        root,
        uri('vscode-remote', 'ssh-remote+host', '/workspace/src/../main.ts'),
      ),
    ).toBeUndefined();
  });
});
