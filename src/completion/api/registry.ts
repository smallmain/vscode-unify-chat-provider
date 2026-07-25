import type { CompletionTemplate, ProviderConfig } from '../../types';
import {
  OLLAMA_GENERATE_PROVIDER_DEFINITION,
} from './ollama-generate-provider';
import {
  OPENAI_COMPLETIONS_PROVIDER_DEFINITION,
} from './openai-completions-provider';
import { INCEPTION_EDIT_PROVIDER_DEFINITION } from './inception-edit-provider';
import { MISTRAL_FIM_PROVIDER_DEFINITION } from './mistral-fim-provider';
import { ZED_PREDICT_EDITS_PROVIDER_DEFINITION } from './zed-predict-edits-provider';
import type {
  CompletionApiProvider,
  NativeCompletionApiContext,
  NativeCompletionApiProviderDefinition,
} from './provider';
import {
  createNativeCompletionApiProvider,
  defineCompletionApiProvider,
  defineNativeCompletionApiProvider,
} from './provider';
import { CompletionInvariantError } from '../model/errors';

export type NativeCompletionApiProviderFactory = (
  context: NativeCompletionApiContext,
) => CompletionApiProvider;

export interface NativeCompletionApiProviderRegistration {
  readonly providerTypes?: readonly ProviderConfig['type'][];
  readonly templates?: readonly CompletionTemplate[];
  readonly definition: NativeCompletionApiProviderDefinition;
}

export class NativeCompletionApiProviderRegistry {
  private readonly factories = new Map<
    ProviderConfig['type'],
    NativeCompletionApiProviderFactory
  >();
  private readonly templateFactories = new Map<
    CompletionTemplate,
    NativeCompletionApiProviderFactory
  >();

  constructor(
    registrations: readonly NativeCompletionApiProviderRegistration[] = [],
  ) {
    for (const registration of registrations) {
      this.register(registration);
    }
  }

  register(registration: NativeCompletionApiProviderRegistration): void {
    const providerTypes = registration.providerTypes ?? [];
    const templates = registration.templates ?? [];
    if (providerTypes.length === 0 && templates.length === 0) {
      throw new CompletionInvariantError(
        'Native Completion API Provider registration is empty.',
      );
    }
    const definition = defineNativeCompletionApiProvider(
      registration.definition,
    );
    const incomingTypes = new Set<ProviderConfig['type']>();
    for (const providerType of providerTypes) {
      if (incomingTypes.has(providerType) || this.factories.has(providerType)) {
        throw new CompletionInvariantError(
          `Native Completion API Provider type "${providerType}" is already registered.`,
        );
      }
      incomingTypes.add(providerType);
    }
    const incomingTemplates = new Set<CompletionTemplate>();
    for (const template of templates) {
      if (
        incomingTemplates.has(template) ||
        this.templateFactories.has(template)
      ) {
        throw new CompletionInvariantError(
          `Native Completion API template "${template}" is already registered.`,
        );
      }
      incomingTemplates.add(template);
    }
    const factory = (context: NativeCompletionApiContext) =>
      createNativeCompletionApiProvider(definition, context);
    for (const providerType of incomingTypes) {
      this.factories.set(providerType, factory);
    }
    for (const template of incomingTemplates) {
      this.templateFactories.set(template, factory);
    }
  }

  create(
    context: NativeCompletionApiContext,
  ): CompletionApiProvider | undefined {
    const factories = new Set<NativeCompletionApiProviderFactory>();
    const providerFactory = this.factories.get(context.provider.type);
    if (providerFactory) factories.add(providerFactory);

    const templates =
      context.completion.templates === 'all'
        ? this.templateFactories.keys()
        : context.completion.templates;
    for (const template of templates) {
      const templateFactory = this.templateFactories.get(template);
      if (templateFactory) factories.add(templateFactory);
    }

    const providers = [...factories].map((factory) => factory(context));
    if (providers.length === 0) return undefined;
    if (providers.length === 1) return providers[0];

    const seenOperations = new Set<string>();
    for (const provider of providers) {
      for (const kind of Object.keys(provider.operations)) {
        if (seenOperations.has(kind)) {
          throw new CompletionInvariantError(
            `Native Completion API operation "${kind}" is registered more than once for this model.`,
          );
        }
        seenOperations.add(kind);
      }
    }

    return defineCompletionApiProvider({
      transport: 'native',
      capabilities: Object.assign(
        {},
        ...providers.map((provider) => provider.capabilities),
      ),
      operations: Object.assign(
        {},
        ...providers.map((provider) => provider.operations),
      ),
    });
  }

  listProviderTypes(): ProviderConfig['type'][] {
    return [...this.factories.keys()];
  }

  listTemplates(): CompletionTemplate[] {
    return [...this.templateFactories.keys()];
  }
}

export const nativeCompletionApiProviderRegistry =
  new NativeCompletionApiProviderRegistry([
    {
      providerTypes: ['openai-chat-completion', 'openai-responses'],
      definition: OPENAI_COMPLETIONS_PROVIDER_DEFINITION,
    },
    {
      providerTypes: ['ollama'],
      definition: OLLAMA_GENERATE_PROVIDER_DEFINITION,
    },
    {
      templates: ['mercury-edit-2'],
      definition: INCEPTION_EDIT_PROVIDER_DEFINITION,
    },
    {
      templates: ['codestral'],
      definition: MISTRAL_FIM_PROVIDER_DEFINITION,
    },
    {
      providerTypes: ['zed'],
      definition: ZED_PREDICT_EDITS_PROVIDER_DEFINITION,
    },
  ]);
