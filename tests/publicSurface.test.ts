import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * What this repository says about CommitRail while CommitRail is not publicly available.
 *
 * The README is a landing page — GitHub renders it, npm renders it — and it is the only thing
 * most people who find this will read. Two kinds of sentence do not belong in it yet, and both
 * arrived once already and had to be taken out.
 *
 * **Forward-looking language.** "Ahead of launch", "coming soon", "will be published when…" are
 * commitments to a timeline nobody has agreed to, and they invite the follow-up question rather
 * than closing it. The notice says what is true in the present tense and stops.
 *
 * **Operational detail.** An earlier version explained that there was no service behind these
 * versions. Accurate, and nobody outside needs the running state of an unlaunched product; it
 * answers a question that was not asked and prompts several that cannot be.
 *
 * **DELETE THIS FILE AT LAUNCH.** The real README says all of these things legitimately, and a
 * guard that outlives its window becomes an obstacle to the thing it was protecting. It is in the
 * launch procedure's checklist for exactly that reason.
 */
describe('the public notice while CommitRail is unavailable', () => {
  const root = path.resolve(__dirname, '..');
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

  const surfaces: [name: string, contents: string][] = [
    ['README.md', read('README.md')],
    ['CHANGELOG.md', read('CHANGELOG.md')],
    ['package.json description', JSON.parse(read('package.json')).description as string],
  ];

  it.each(surfaces)('%s promises no timeline', (_name, contents) => {
    const forwardLooking = [
      /\blaunch(ing|es|ed)?\b/i,
      /coming soon/i,
      /\bwill be (published|available|released)\b/i,
      /\bshortly\b/i,
      /\bstay tuned\b/i,
      /\bearly access\b/i,
      /\bwaitlist\b/i,
    ];

    const found = forwardLooking.filter((pattern) => pattern.test(contents)).map(String);

    expect(found, `promises a timeline nobody has agreed to: ${found.join(', ')}`).toEqual([]);
  });

  it.each(surfaces)('%s says nothing about what we do or do not run', (_name, contents) => {
    const operational = [
      /no service behind/i,
      /\bnot (yet )?deployed\b/i,
      /\bstaging\b/i,
      /\bproduction (environment|deployment)\b/i,
      /\bregion\b/i,
      /\buptime\b/i,
    ];

    const found = operational.filter((pattern) => pattern.test(contents)).map(String);

    expect(found, `discloses operational state: ${found.join(', ')}`).toEqual([]);
  });

  it('keeps the README short enough to be a notice rather than a page', () => {
    // Length is the proxy that catches everything the patterns above do not. The moment somebody
    // starts explaining the product here, this fails and they have to notice they are doing it.
    const lines = read('README.md')
      .split('\n')
      .filter((line) => line.trim() !== '');

    expect(lines.length).toBeLessThan(15);
  });
});
