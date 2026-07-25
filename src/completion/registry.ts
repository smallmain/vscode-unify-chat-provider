import type {
  CompletionAlgorithmDefinition,
  CompletionAlgorithmId,
} from './types';

export class CompletionAlgorithmRegistry {
  private readonly definitions = new Map<
    CompletionAlgorithmId,
    CompletionAlgorithmDefinition
  >();

  constructor(definitions: readonly CompletionAlgorithmDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: CompletionAlgorithmDefinition): void {
    if (this.definitions.has(definition.id)) {
      throw new Error(
        `Completion algorithm "${definition.id}" is already registered.`,
      );
    }
    this.definitions.set(definition.id, definition);
  }

  get(id: CompletionAlgorithmId): CompletionAlgorithmDefinition | undefined {
    return this.definitions.get(id);
  }

  list(): CompletionAlgorithmDefinition[] {
    return [...this.definitions.values()];
  }
}
