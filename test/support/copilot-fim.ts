import type { FimDefaultDiagnosticsOptions } from '../../src/chat-lib/core/behavior-config';
import type { GhostTextPromptContext } from '../../src/chat-lib/core/ghost-text';
import {
  FimWorkspaceContextAdapter,
} from '../../src/completion/copilot/fim-runtime-utils';
import type { CopilotWorkspaceAdapter } from '../../src/completion/copilot/workspace';

export * from '../../src/completion/copilot/fim-runtime-utils';

export function coreContextFromWorkspace(
  workspace: Awaited<ReturnType<CopilotWorkspaceAdapter['gatherContext']>>,
  options: {
    readonly defaultDiagnostics?: FimDefaultDiagnosticsOptions | null;
    readonly cursorOffset?: number;
  } = {},
): GhostTextPromptContext {
  return new FimWorkspaceContextAdapter(
    options.defaultDiagnostics ?? null,
  ).adapt(workspace, Number.POSITIVE_INFINITY, options.cursorOffset);
}
