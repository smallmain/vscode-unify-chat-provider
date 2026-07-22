export function countNesTokens(text: string): number {
  return Math.floor(text.length / 4);
}

export function countNesLineTokens(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + countNesTokens(line) + 1, 0);
}
