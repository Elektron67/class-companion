// packages/string-normalizer/tests/normalizer.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhrase, phrasesMatch } from '../src/index.ts';

describe('String Normalizer & Phrase Matcher', () => {
  it('handles null, undefined, and empty string', () => {
    assert.equal(normalizePhrase(null), '');
    assert.equal(normalizePhrase(undefined), '');
    assert.equal(normalizePhrase(''), '');
  });

  it('converts to lowercase', () => {
    assert.equal(normalizePhrase('PHOTOSYNTHESIS'), 'photosynthesis');
    assert.equal(normalizePhrase('mItoChoNdRia'), 'mitochondria');
  });

  it('trims leading and trailing whitespace', () => {
    assert.equal(normalizePhrase('   hello world   '), 'hello world');
    assert.equal(normalizePhrase('\t\nbiology\r\n\t'), 'biology');
  });

  it('collapses internal repeated whitespace into a single space', () => {
    assert.equal(normalizePhrase('Cell   division   phase 1'), 'cell division phase 1');
    assert.equal(normalizePhrase('Molecules\t\tand\n\nAtoms'), 'molecules and atoms');
  });

  it('normalizes Unicode characters via NFKC', () => {
    // Full-width latin characters to standard ASCII
    assert.equal(normalizePhrase('ｐｈｏｔｏｓｙｎｔｈｅｓｉｓ'), 'photosynthesis');
    // Ligatures & compatibility characters
    assert.equal(normalizePhrase('ﬁrst'), 'first');
  });

  it('correctly matches matching pairs under varied formatting', () => {
    assert.ok(phrasesMatch('Photosynthesis', 'photosynthesis'));
    assert.ok(phrasesMatch('  Mitosis   Phase 1  ', 'mitosis phase 1'));
    assert.ok(phrasesMatch('E = mc^2', '  e = mc^2  '));
    assert.ok(phrasesMatch('World\tHistory\n101', 'world history 101'));
  });

  it('fails mismatched words and missing words', () => {
    assert.equal(phrasesMatch('Photosynthesis', 'cellular respiration'), false);
    // Preserves word boundaries: collapsing spaces means removing space will not match
    assert.equal(phrasesMatch('World History', 'WorldHistory'), false);
    assert.equal(phrasesMatch('Phase 1', 'Phase 2'), false);
  });
});
