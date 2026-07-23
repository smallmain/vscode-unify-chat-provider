import type * as vscode from 'vscode';
import {
  readProposedApiManifestSnapshot,
  type ProposedApiManifestSnapshot,
} from './manifest';

export const LANGUAGE_MODEL_THINKING_PART_PROPOSAL =
  'languageModelThinkingPart';

export interface ProposedApiCapabilities {
  readonly declared: readonly string[];
  readonly enabled: readonly string[];
  readonly missing: readonly string[];
  isProposedEnabled(proposal: string): boolean;
  isProposedCanUse(proposal: string): boolean;
}

export interface ProposedApiRuntimeCapabilities {
  canUseLanguageModelThinkingPart(): boolean;
}

class ProposedApiCapabilitiesSnapshot implements ProposedApiCapabilities {
  readonly declared: readonly string[];
  readonly enabled: readonly string[];
  readonly missing: readonly string[];
  private readonly enabledSet: ReadonlySet<string>;

  constructor(
    manifest: ProposedApiManifestSnapshot,
    private readonly runtime: ProposedApiRuntimeCapabilities,
  ) {
    this.declared = Object.freeze([...manifest.declared]);
    this.enabled = Object.freeze([...manifest.enabled]);
    this.enabledSet = new Set(this.enabled);
    this.missing = Object.freeze(
      this.declared.filter((proposal) => !this.enabledSet.has(proposal)),
    );
  }

  isProposedEnabled(proposal: string): boolean {
    return this.enabledSet.has(proposal);
  }

  isProposedCanUse(proposal: string): boolean {
    return proposal === LANGUAGE_MODEL_THINKING_PART_PROPOSAL
      ? this.runtime.canUseLanguageModelThinkingPart()
      : this.isProposedEnabled(proposal);
  }
}

export function createProposedApiCapabilities(
  manifest: ProposedApiManifestSnapshot,
  runtime: ProposedApiRuntimeCapabilities,
): ProposedApiCapabilities {
  return new ProposedApiCapabilitiesSnapshot(manifest, runtime);
}

export async function initializeProposedApiCapabilities(
  context: vscode.ExtensionContext,
  runtime: ProposedApiRuntimeCapabilities,
): Promise<ProposedApiCapabilities> {
  return createProposedApiCapabilities(
    await readProposedApiManifestSnapshot(context),
    runtime,
  );
}
