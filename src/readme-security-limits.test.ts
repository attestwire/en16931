import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_XML_LIMITS } from './xml-parse';

// 2026-08-17. Version 0.7.3 raised the default character cap from 400,000 to
// 8,000,000, and the README's "Security limits" table kept saying 400,000.
// npmjs.com renders this README; a published tarball cannot be edited
// afterwards. This gate pins every number in that table to
// DEFAULT_XML_LIMITS so the two cannot disagree again.
const readme = readFileSync(
  fileURLToPath(new URL('../README.md', import.meta.url)),
  'utf8',
);

// Each row is matched by its defence label and its error code, with the
// number in between. If a rewording breaks a pattern the test fails loudly
// on the extraction itself — a gate whose regex silently stops matching is
// inert, which is the exact mistake readme-kosit-claim.test.ts documents.
const rows: Array<[name: string, pattern: RegExp, expected: number]> = [
  [
    'Size cap',
    /\| Size cap \| ([\d,]+) characters \(`xml_too_large`\)/,
    DEFAULT_XML_LIMITS.maxCharacters,
  ],
  [
    'Depth cap',
    /\| Depth cap \| ([\d,]+) elements \(`xml_too_deep`\)/,
    DEFAULT_XML_LIMITS.maxDepth,
  ],
  [
    'Element cap',
    /\| Element cap \| ([\d,]+) elements \(`xml_too_many_elements`\)/,
    DEFAULT_XML_LIMITS.maxElements,
  ],
  [
    'Attribute cap',
    /\| Attribute cap \| ([\d,]+) per element \(`xml_too_many_attributes`\)/,
    DEFAULT_XML_LIMITS.maxAttributes,
  ],
];

describe('README security-limits table matches DEFAULT_XML_LIMITS', () => {
  for (const [name, pattern, expected] of rows) {
    it(`${name} row quotes ${expected}`, () => {
      const match = pattern.exec(readme);
      if (!match) {
        throw new Error(
          `README.md has no "${name}" row matching ${pattern}. If the table ` +
            'was reworded, update this test so the gate stays live.',
        );
      }
      expect(Number(match[1].replaceAll(',', ''))).toBe(expected);
    });
  }

  it('the raise-the-limit example is actually a raise', () => {
    // "can be raised per call: `parseUbl(xml, { maxCharacters: 16_000_000 })`"
    // — before 0.7.3 raised the default, this example read 2_000_000, which
    // the raise turned into a silent lowering.
    const match = /maxCharacters: ([\d_]+)/.exec(readme);
    if (!match) {
      throw new Error(
        'README.md no longer shows a maxCharacters example below the table.',
      );
    }
    expect(Number(match[1].replaceAll('_', ''))).toBeGreaterThan(
      DEFAULT_XML_LIMITS.maxCharacters,
    );
  });
});
