// packages/string-normalizer/src/index.ts

/**
 * Normalizes input phrases for case-insensitive, whitespace-tolerant comparison.
 *
 * Rules:
 * 1. Normalize Unicode characters to Compatibility Decomposition followed by Canonical Composition (NFKC).
 * 2. Convert to lowercase.
 * 3. Trim leading and trailing whitespace.
 * 4. Collapse internal whitespace sequences (tabs, newlines, multiple spaces) to a single ASCII space (' ').
 *
 * Assumption: Internal spaces are collapsed rather than removed entirely to preserve word boundaries
 * (e.g. "photosynthesis in plants" vs "photosynthesisinplants").
 */
export function normalizePhrase(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function phrasesMatch(inputA: string, inputB: string): boolean {
  return normalizePhrase(inputA) === normalizePhrase(inputB);
}
