/** Argument parsing, kept separate so it can be tested without running a command. */

export interface Args {
  /** `--budget 700` -> { budget: '700' }; a bare `--activate` -> 'true'. */
  flags: Record<string, string>;
  positional: string[];
}

export function parseArgs(argv: string[]): { command: string | undefined; args: Args } {
  const [command, ...rest] = argv;
  return {
    command,
    args: {
      flags: parseFlags(rest),
      positional: rest.filter((a) => !a.startsWith('--') && !isFlagValue(rest, a)),
    },
  };
}

export function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = 'true';
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

/** A bare word that follows a flag is that flag's value, not a positional. */
export function isFlagValue(args: string[], value: string): boolean {
  const index = args.indexOf(value);
  return index > 0 && args[index - 1]!.startsWith('--');
}

export function flagIsSet(args: Args, name: string): boolean {
  return args.flags[name] === 'true';
}

/** Money arrives from the CLI in major units and is stored in minor ones. */
export function minorFromFlag(args: Args, name: string): number | undefined {
  const raw = args.flags[name];
  return raw === undefined ? undefined : Math.round(Number(raw) * 100);
}
