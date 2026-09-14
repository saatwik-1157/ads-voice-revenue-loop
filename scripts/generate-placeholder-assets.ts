import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PLACEHOLDER_THEMES, renderPlaceholder } from '../src/creative/placeholder.ts';
import { GENERATED_MANIFEST } from '../src/creative/library.ts';

/**
 * Fill assets/ with abstract placeholder artwork, for demonstrating the
 * library path when no real artwork exists.
 *
 *   node scripts/generate-placeholder-assets.ts
 *
 * This does NOT make the result cleared artwork, and it is careful not to
 * pretend otherwise. Every file it writes is recorded in a manifest, the
 * library provider reads that manifest and keeps reporting these as
 * machine-made, and gate #1 goes on warning that a person has not vouched for
 * the imagery. Replace them with real files - and delete the manifest - when
 * you have artwork you own.
 */

const dir = resolve(process.cwd(), process.argv[2] ?? 'assets');
mkdirSync(dir, { recursive: true });

const written: string[] = [];
for (const theme of PLACEHOLDER_THEMES) {
  for (const variant of [1, 2]) {
    const filename = `${theme.name}-0${variant}.png`;
    const bytes = renderPlaceholder(theme, variant).toPng();
    writeFileSync(join(dir, filename), bytes);
    written.push(filename);
    process.stdout.write(`  ${filename.padEnd(24)} ${(bytes.length / 1024).toFixed(0)} KB\n`);
  }
}

writeFileSync(
  join(dir, GENERATED_MANIFEST),
  `${JSON.stringify(
    {
      note: 'Machine-generated placeholder artwork. Nobody has cleared these for use against a real budget.',
      generatedAt: new Date().toISOString(),
      generatedBy: 'scripts/generate-placeholder-assets.ts',
      generated: written,
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(`\n${written.length} placeholder images in ${dir}\n`);
process.stdout.write(`recorded in ${GENERATED_MANIFEST}, so they still report as machine-made\n`);
