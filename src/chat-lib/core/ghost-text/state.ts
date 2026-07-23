import type { GhostTextModelChoice } from './types';

interface CacheContent {
  suffix: string;
  choices: GhostTextModelChoice[];
}

interface CacheNode {
  prefix: string;
  contents: CacheContent[];
}

export class GhostTextCompletionCache {
  private readonly nodes = new Map<string, CacheNode>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('GhostText cache capacity must be a positive integer.');
    }
  }

  get size(): number {
    return this.nodes.size;
  }

  append(
    prefix: string,
    suffix: string,
    choice: GhostTextModelChoice,
  ): void {
    for (const [key, node] of this.prefixNodes(prefix)) {
      this.nodes.delete(key);
      this.nodes.set(key, node);
    }
    const existing = this.nodes.get(prefix);
    const contents = existing ? [...existing.contents] : [];
    const contentIndex = contents.findIndex((content) => content.suffix === suffix);
    if (contentIndex >= 0) {
      const content = contents[contentIndex];
      contents[contentIndex] = {
        ...content,
        choices: [...content.choices, choice],
      };
    } else {
      contents.push({ suffix, choices: [choice] });
    }
    const node: CacheNode = { prefix, contents };
    this.nodes.delete(prefix);
    this.nodes.set(prefix, node);
    while (this.nodes.size > this.capacity) {
      const oldest = this.nodes.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.nodes.delete(oldest);
    }
  }

  findAll(prefix: string, suffix: string): readonly GhostTextModelChoice[] {
    const results: GhostTextModelChoice[] = [];
    for (const [key, node] of this.prefixNodes(prefix)) {
      this.nodes.delete(key);
      this.nodes.set(key, node);
      const content = node.contents.find((candidate) => candidate.suffix === suffix);
      if (!content) {
        continue;
      }
      const remainingPrefix = prefix.slice(node.prefix.length);
      for (const choice of content.choices) {
        if (
          choice.completionText.startsWith(remainingPrefix) &&
          choice.completionText.length > remainingPrefix.length
        ) {
          results.push({
            ...choice,
            completionText: choice.completionText.slice(remainingPrefix.length),
          });
        }
      }
    }
    return results;
  }

  clear(): void {
    this.nodes.clear();
  }

  private prefixNodes(prefix: string): Array<[string, CacheNode]> {
    return [...this.nodes]
      .filter(([, node]) => prefix.startsWith(node.prefix))
      .sort(([, left], [, right]) => right.prefix.length - left.prefix.length);
  }
}

export class GhostTextCurrentCompletion {
  private prefix?: string;
  private suffix?: string;
  private choices: readonly GhostTextModelChoice[] = [];

  get clientCompletionId(): string | undefined {
    return this.choices[0]?.clientCompletionId;
  }

  set(
    prefix: string,
    suffix: string,
    choices: readonly GhostTextModelChoice[],
    typingAsSuggested: boolean,
  ): void {
    if (typingAsSuggested) {
      return;
    }
    this.prefix = prefix;
    this.suffix = suffix;
    this.choices = choices;
  }

  forTyping(
    prefix: string,
    suffix: string,
  ): readonly GhostTextModelChoice[] | undefined {
    const remaining = this.remainingPrefix(prefix, suffix);
    if (remaining === undefined) {
      return undefined;
    }
    const firstChoice = this.choices[0];
    if (
      !firstChoice?.completionText.startsWith(remaining) ||
      firstChoice.completionText.length <= remaining.length
    ) {
      return undefined;
    }
    const choices = this.choices
      .filter(
        (choice) =>
          choice.completionText.startsWith(remaining) &&
          choice.completionText.length > remaining.length,
      )
      .map((choice) => ({
        ...choice,
        completionText: choice.completionText.slice(remaining.length),
      }));
    return choices.length > 0 ? choices : undefined;
  }

  hasAccepted(prefix: string, suffix: string): boolean {
    const remaining = this.remainingPrefix(prefix, suffix);
    return (
      remaining !== undefined &&
      remaining === this.choices[0]?.completionText &&
      this.choices[0]?.finishReason === 'stop'
    );
  }

  clear(): void {
    this.prefix = undefined;
    this.suffix = undefined;
    this.choices = [];
  }

  private remainingPrefix(
    prefix: string,
    suffix: string,
  ): string | undefined {
    if (
      this.prefix === undefined ||
      this.suffix === undefined ||
      this.choices.length === 0 ||
      this.suffix !== suffix ||
      !prefix.startsWith(this.prefix)
    ) {
      return undefined;
    }
    return prefix.slice(this.prefix.length);
  }
}
