import { get_encoding, type Tiktoken } from 'tiktoken';
import type { GhostTextTokenizer } from './types';

let sharedTokenizer: Tiktoken | undefined;
const textDecoder = new TextDecoder();

function getSharedTokenizer(): Tiktoken {
  sharedTokenizer ??= get_encoding('o200k_base');
  return sharedTokenizer;
}

/** The pinned upstream prompt defaults to the o200k tokenizer. */
export class O200kGhostTextTokenizer implements GhostTextTokenizer {
  encode(text: string): readonly number[] {
    return Array.from(getSharedTokenizer().encode(text));
  }

  decode(tokens: readonly number[]): string {
    return textDecoder.decode(
      getSharedTokenizer().decode(new Uint32Array(tokens)),
    );
  }

  count(text: string): number {
    return getSharedTokenizer().encode(text).length;
  }

  takeFirst(
    text: string,
    maxTokens: number,
  ): { text: string; tokens: readonly number[] } {
    if (maxTokens <= 0) {
      return { text: '', tokens: [] };
    }
    let characters = Math.min(text.length, maxTokens * 4);
    let prefix = text.slice(0, characters);
    let tokens = this.encode(prefix);
    while (tokens.length < maxTokens + 2 && characters < text.length) {
      characters = Math.min(text.length, characters + maxTokens);
      prefix = text.slice(0, characters);
      tokens = this.encode(prefix);
    }
    if (tokens.length < maxTokens) {
      return { text, tokens };
    }
    const selected = tokens.slice(0, maxTokens);
    return { text: this.decode(selected), tokens: selected };
  }

  takeLast(
    text: string,
    maxTokens: number,
  ): { text: string; tokens: readonly number[] } {
    if (maxTokens <= 0) {
      return { text: '', tokens: [] };
    }
    let characters = Math.min(text.length, maxTokens * 4);
    let suffix = text.slice(-characters);
    let tokens = this.encode(suffix);
    while (tokens.length < maxTokens + 2 && characters < text.length) {
      characters = Math.min(text.length, characters + maxTokens);
      suffix = text.slice(-characters);
      tokens = this.encode(suffix);
    }
    if (tokens.length < maxTokens) {
      return { text, tokens };
    }
    const selected = tokens.slice(-maxTokens);
    return { text: this.decode(selected), tokens: selected };
  }

  tokenizeStrings(text: string): readonly string[] {
    return this.encode(text).map((token) => this.decode([token]));
  }
}
