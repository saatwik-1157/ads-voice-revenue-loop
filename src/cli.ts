import { createContext } from './orchestrator.ts';
import { parseArgs } from './cli/args.ts';
import { writeRaw } from './cli/io.ts';
import { findCommand, usageText } from './cli/registry.ts';
import { GuardrailViolation } from './config/guardrails.ts';
import { AssetError } from './creative/provider.ts';
import { MetaApiError } from './meta/provider.ts';
import { VoiceApiError } from './voice/provider.ts';

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
  } catch (err) {
    return report(err);
  } finally {
    // `serve` blocks forever; closing the store under it would be a bug.
    if (!handler.holdsProcess) ctx.store.close();
  }
}

/**
 * A refusal is not a crash.
 *
 * A guardrail stopping a publish, a provider rejecting a request, an unusable
 * image - these are the system working, and printing a stack trace into
 * publisher.ts for them buries the reason under machinery the operator cannot
 * act on. Genuine bugs still get their stack, because for those the machinery
 * is exactly what you need.
 */
function report(err: unknown): number {
  if (err instanceof GuardrailViolation) {
    process.stderr.write(`refused by the control layer: ${err.message}\n`);
    process.stderr.write('nothing was published, spent or dialled.\n');
    return 1;
  }
  if (err instanceof AssetError || err instanceof MetaApiError || err instanceof VoiceApiError) {
    process.stderr.write(`${err.name}: ${err.message}\n`);
    return 1;
  }
  process.stderr.write(`unexpected failure - this is a bug, not a refusal:\n${String((err as Error).stack ?? err)}\n`);
  return 1;
}

const code = await main(process.argv.slice(2));
process.exit(code);
