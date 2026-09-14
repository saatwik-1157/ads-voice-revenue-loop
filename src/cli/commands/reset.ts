import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from '../registry.ts';
import { flagIsSet } from '../args.ts';
import { fail, write } from '../io.ts';

/**
 * Throwing away local state between demos.
 *
 * Deliberately blunt and deliberately guarded: it deletes the database, the
 * simulated ad account and the generated previews, which is exactly what you
 * want between demo runs and exactly what you never want against a live one.
 */
export const resetCommands: Command[] = [
  {
    name: 'reset',
    usage: '--yes',
    summary: 'Delete the local database, mock state and previews',
    run: (ctx, args) => {
      if (ctx.env.mode === 'live') {
        return Promise.resolve(
          fail(
            [
              'refusing to reset while FL_MODE=live.',
              'The local database is the only record of which leads were called and',
              'which numbers opted out. Deleting it does not stop the campaign - it',
              'just means the system no longer knows what it already did.',
            ].join('\n'),
          ),
        );
      }

      const targets = [ctx.env.dbPath, `${ctx.env.dbPath}-wal`, `${ctx.env.dbPath}-shm`, 'data/mock-meta.json', ctx.env.previewDir];
      const present = targets.filter((t) => t !== ':memory:' && existsSync(resolve(process.cwd(), t)));

      if (!flagIsSet(args, 'yes')) {
        write(present.length ? 'would delete:' : 'nothing to delete.');
        for (const target of present) write(`  ${target}`);
        if (present.length) write('\nre-run with --yes to do it.');
        return Promise.resolve(0);
      }

      // The store holds an open handle to the database it is about to delete.
      ctx.store.close();
      for (const target of present) {
        rmSync(resolve(process.cwd(), target), { recursive: true, force: true });
        write(`deleted ${target}`);
      }
      write(present.length ? '\nfresh. start again with: node src/cli.ts brief' : 'nothing to delete.');
      return Promise.resolve(0);
    },
  },
];
