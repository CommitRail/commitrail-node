import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * What this repository says about CommitRail, in the places strangers read it.
 *
 * Three surfaces, and they leak differently.
 *
 * **The README and the changelog** are a landing page: GitHub renders them, npm renders them,
 * and they are the only thing most people who find this will read. Two kinds of sentence do not
 * belong there and both arrived once already — language committing to a timeline nobody has
 * agreed to, and detail about what is or is not running. The notice says what is true in the
 * present tense and stops.
 *
 * **`src/` is not source, it is documentation.** `tsconfig.json` sets no `removeComments`, so
 * every JSDoc block here is copied verbatim into the published `.d.ts` files and renders in a
 * customer's editor on hover. A comment naming an internal document, an internal component or a
 * surface nobody can reach is shipped to npm, not merely written down. That is how
 * `docs/defects.md` and `docs/benchmarks/…` came to sit inside `dist/esm/*.d.ts`.
 *
 * **A repo-relative path in `src/` dangles by construction.** The tarball is `dist`, `README.md`
 * and `LICENSE` — no `src/`, no `tests/`, no `vectors/`, no `docs/` — so a comment citing one is
 * pointing a customer at a file they do not have.
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
   * A private document, an internal component, or a surface nobody can reach yet.
   *
   * Each of these was found in this repository rather than imagined. `docs/…` named the
   * monorepo's design notes, defect log and benchmark write-ups; `tests/integration/…` named a
   * path that exists only in the monorepo; "the console" named a surface no customer can open;
   * "capture" and "preflight" named server components by their internal names.
   */
  const internal: [pattern: RegExp, why: string][] = [
    [/\bdocs\/[a-z0-9-]+/i, 'names a document in the private monorepo'],
    [/\bPROTOCOL\.md\b/, 'names a file that does not exist in this repository'],
    [/\bCONTRIBUTING\.md\b/, 'names a file that does not exist in this repository'],
    [/\btests\/integration\//, 'names a test path that exists only in the private monorepo'],
    [/\bcontrol plane\b/i, 'names CommitRail Cloud internals'],
    [/\bdata plane\b/i, 'names CommitRail Cloud internals'],
    [/\bin the console\b/i, 'names a surface a customer cannot reach today'],
  ];

  /**
   * Narration about us rather than description for the reader.
   *
   * A comment in `src/` is documentation on a customer's disk. It should describe what is in
   * front of whoever is reading it — never our history, our other components, our test suite or
   * a design we considered and dropped. Every tell below was written in this file at some point.
   */
  const narration: [pattern: RegExp, why: string][] = [
    [/\bthe suite\b/i, 'refers to our test suite'],
    [/\bmonorepo\b/i, 'refers to the private repository'],
    [/\bpack(ag)?ing gate\b/i, 'refers to our release tooling'],
    [/\bconformance vector/i, 'refers to a file the package does not contain'],
    [
      /\bour (server|backend|internals|routes|functions)\b/i,
      'narrates our side, not the reader\u2019s',
    ],
    [/\bthe rejected (version|design|alternative)\b/i, 'narrates a design we dropped'],
    [/\bused to say\b/i, 'narrates this file\u2019s own history'],
    [/\bnot worth paying\b/i, 'narrates work we have deferred'],
  ];

  it.each(files)('%s names nothing internal', (file) => {
    const contents = readFileSync(path.join(root, file), 'utf8');

    const found = internal
      .filter(([pattern]) => pattern.test(contents))
      .map(([pattern, why]) => `${pattern} — ${why}`);

    expect(found, `${file}\n  ${found.join('\n  ')}`).toEqual([]);
  });

  // Scoped to `src/`, because these are only a problem in what gets published. A test may say
  // "the suite" and a workflow may say "monorepo"; a `.d.ts` on a customer's disk may not.
  it.each(files.filter((f) => f.startsWith('src')))(
    '%s describes the reader\u2019s side, not ours',
    (file) => {
      const contents = readFileSync(path.join(root, file), 'utf8');

      const found = narration
        .filter(([pattern]) => pattern.test(contents))
        .map(([pattern, why]) => `${pattern} — ${why}`);

      expect(found, `${file}\n  ${found.join('\n  ')}`).toEqual([]);
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
