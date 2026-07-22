import { randomUUID } from 'node:crypto';
import { GhostTextEngine } from './engine';
import { FimGhostTextModelBoundary } from './model-boundary';
import type { CompletionModel } from '../../../completion/types';
import type { GhostTextEngineDependencies } from './types';

export * from './behavior';
export * from './engine';
export * from './model-boundary';
export * from './multiline';
export * from './postprocess';
export * from './prompt';
export * from './recent-edits';
export * from './state';
export * from './tokenizer';
export * from './types';

export type FimGhostTextEngineOptions = Omit<
  GhostTextEngineDependencies,
  'model'
>;

export function createFimGhostTextEngine(
  model: CompletionModel,
  options: FimGhostTextEngineOptions = {},
): GhostTextEngine {
  const idFactory = options.idFactory ?? randomUUID;
  return new GhostTextEngine({
    ...options,
    idFactory,
    model: new FimGhostTextModelBoundary(model, idFactory),
  });
}
