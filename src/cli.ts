import { createContext } from './orchestrator.ts';
import { parseArgs } from './cli/args.ts';
import { writeRaw } from './cli/io.ts';
import { findCommand, usageText } from './cli/registry.ts';

/**
 * The entry point, and nothing else.
 *
 * Every command lives in src/cli/commands/ and registers itself with its own
 * usage line, so the help text is generated rather than maintained alongside
 * the code it describes - the hand-written version had already drifted.
 */
async function main(argv: string[]): Promise<number> {
  const { command, args } = parseArgs(argv);

  if (!command || command === 'help' || command === '--help') {
    writeRaw(`${usageText()}\n`);
    return 0;
  }

  const handler = findCommand(command);
  if (!handler) {
    process.stderr.write(`unknown command "${command}"\n\n${usageText()}\n`);
    return 1;
  }

  const ctx = createContext();
  try {
    return await handler.run(ctx, args);
  } finally {
    // `serve` blocks forever; closing the store under it would be a bug.
    if (!handler.holdsProcess) ctx.store.close();
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
