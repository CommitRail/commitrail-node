import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * What this package promises, and what its comments can actually resolve to.
 *
 * `tsconfig.json` sets no `removeComments`, so every JSDoc block in `src/` is copied verbatim into
 * the published `.d.ts` and `.js`. A comment here is documentation on a customer's disk, rendered
 * in their editor on hover — not a note to whoever edits this file next.
 *
 * Two consequences, and both are about what a reader can reach from where they stand.
 *
 * **A repo-relative path dangles by construction.** The tarball is `dist`, `README.md` and
 * `LICENSE`, so a comment citing `tests/`, `vectors/` or `scripts/` points at a file the reader
 * does not have.
 *
 * **A tooltip has no "above" and no "below."** An editor renders one symbol with nothing around
 * it, so a positional reference resolves perfectly here and to nothing where it is read.
 *
 * The README is checked for the one sentence that does not belong on a landing page: a commitment
 * to a timeline nobody has agreed to.
 */
describe('the public notice', () => {
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

  it('keeps the README short enough to be a notice rather than a page', () => {
    // Length is the proxy that catches everything the patterns above do not. The moment somebody
    // starts explaining the product here, this fails and they have to notice they are doing it.
    const lines = read('README.md')
      .split('\n')
      .filter((line) => line.trim() !== '');

    expect(lines.length).toBeLessThan(15);
  });
});

describe('comments that get published', () => {
  const root = path.resolve(__dirname, '..');

  /**
   * Everything a stranger can read, minus this file.
   *
   * Excluded because the patterns below are written here as literals, and a scanner that reads
   * its own rules reports itself. `src/` matters most — it reaches npm — but `tests/`,
   * `scripts/`, `vectors/` and the workflows are all public on GitHub, and an internal document
   * named in any of them is named just as loudly.
   */
  const walk = (dir: string): string[] =>
    readdirSync(path.join(root, dir)).flatMap((entry) => {
      const rel = path.join(dir, entry);
      return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
    });

  const files = ['src', 'tests', 'scripts', 'vectors', '.github/workflows']
    .flatMap(walk)
    .filter((f) => f !== path.join('tests', 'publicSurface.test.ts'));

  /**
   * A tooltip has no "above" and no "below".
   *
   * Every JSDoc block in `src/` is copied into the published `.d.ts`, where an editor renders one
   * symbol at a time with nothing around it. A positional reference resolves perfectly in the
   * source file and to nothing at all where it is actually read, which is why five of these
   * survived four passes over `src/`.
   *
   * The migration SQL is copied further still: it is text a customer pastes into their own
   * migration files, so "the table above" lands in a different file of theirs.
   *
   * Name the thing instead. `transaction()` and `correlationId` mean the same in a tooltip as in
   * a file.
   *
   * Scoped to `src/` as a whole rather than to exported symbols, which makes it slightly wider
   * than the rule: a private function's block never reaches a `.d.ts`, so nobody hovers it. It is
   * still published in `dist/esm/*.js` — every comment is — and every fix this over-reach has
   * asked for so far was an improvement anyway. Narrow it if that stops being true.
   */
  it.each(files.filter((f) => f.startsWith('src')))(
    '%s refers to nothing by its position',
    (file) => {
      const contents = readFileSync(path.join(root, file), 'utf8');

      const positional = [
        /\b(?:the )?(?:note|table|constant|statement|example|list|members?|field|method|type)s? (?:defined |declared )?(?:above|below)\b/i,
        /\b(?:see|prefer|described|explained|listed)\b[^.]{0,40}?\b(?:above|below)\b/i,
        /\beverything above\b/i,
        /\bthe (?:one|section|paragraph) (?:above|below)\b/i,
      ];

      const found = contents
        .split('\n')
        .map((line, index) => [line, index + 1] as const)
        .filter(([line]) => positional.some((pattern) => pattern.test(line)))
        .map(([line, number]) => `${number}: ${line.trim()}`);

      expect(
        found,
        `${file} points at something by position, which resolves to nothing on hover:\n  ${found.join('\n  ')}`,
      ).toEqual([]);
    },
  );

  /**
   * A path in `src/` is a promise the tarball cannot keep.
   *
   * Scoped to `src/` alone: a test citing a sibling test is fine, because whoever is reading it
   * has the repository. A `.d.ts` on a customer's disk does not.
   */
  it.each(files.filter((f) => f.startsWith('src')))(
    '%s cites no path the published package does not contain',
    (file) => {
      const contents = readFileSync(path.join(root, file), 'utf8');
      const dangling = [/\btests\//, /\bvectors\//, /\bscripts\//, /\bdocs\//, /\.md\b/];

      const found = dangling.filter((pattern) => pattern.test(contents)).map(String);

      expect(
        found,
        `${file} cites a path that ships in the repository but not in the package: ${found.join(', ')}`,
      ).toEqual([]);
    },
  );
});
