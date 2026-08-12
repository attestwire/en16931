import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 2026-08-11. Version 0.2.0 was published to npm on 2026-08-10. The KoSIT
// conformance run happened on 2026-08-11 — one day later. So the README inside
// the published 0.2.0 tarball said, in bold, "The KoSIT run for 0.2.0 has not
// been performed", while attestwire.com said the fixtures pass. Both were true
// when written; neither could be edited without republishing.
//
// That is the worst class of defect this project can ship. The homepage's
// headline is "Don't trust us. Run it." — and the first place a developer goes
// to verify is npmjs.com, which renders this README. Getting caught
// overstating *verification* is worse than overstating a feature.
//
// This gate makes the two artefacts unable to disagree: if kosit-check.md
// records a result, the README may not say the run is missing, and vice versa.
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('README and the recorded KoSIT run cannot contradict each other', () => {
  const readme = read('../README.md');
  const record = read('../scripts/kosit-check.md');

  // "Acceptable: 3  Rejected: 0" — the validator's own summary line.
  const recordedVerdict = /Acceptable:\s*(\d+)\s+Rejected:\s*(\d+)/.exec(record);
  const runWasPerformed = Boolean(recordedVerdict);

  // NB: do not use `[^.]` as the gap here — version strings ("0.2.0") contain
  // dots, so a dot-excluding gap silently never matches and the gate is inert.
  // That exact mistake was made when this file was written, and caught only by
  // asserting the gate against the historical text below.
  const readmeDeniesTheRun = /(KoSIT|\brun\b)[\s\S]{0,120}?has not been performed/i.test(readme);

  it('does not deny a run that scripts/kosit-check.md records', () => {
    if (runWasPerformed && readmeDeniesTheRun) {
      throw new Error(
        'kosit-check.md records a completed run but README.md still says the run ' +
          'has not been performed. Update the README before publishing — the ' +
          'published tarball cannot be edited afterwards.',
      );
    }
    expect(runWasPerformed && readmeDeniesTheRun).toBe(false);
  });

  it('does not claim a run that scripts/kosit-check.md does not record', () => {
    const readmeAssertsPass = /Acceptable:\s*\d+\s+Rejected:\s*0/.test(readme);
    if (readmeAssertsPass && !runWasPerformed) {
      throw new Error(
        'README.md quotes a passing KoSIT verdict that kosit-check.md does not record.',
      );
    }
    expect(readmeAssertsPass && !runWasPerformed).toBe(false);
  });

  it('quotes the same fixture count the record does', () => {
    if (!recordedVerdict) return;
    const [, acceptable, rejected] = recordedVerdict;
    expect(rejected).toBe('0');
    // If the README quotes a count at all, it must be the recorded one.
    const quoted = /Acceptable:\s*(\d+)\s+Rejected:\s*0/.exec(readme);
    if (quoted) expect(quoted[1]).toBe(acceptable);
  });
});
