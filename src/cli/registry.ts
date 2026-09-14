import type { Context } from '../orchestrator.ts';
import type { Args } from './args.ts';
import { lifecycleCommands } from './commands/lifecycle.ts';
import { approvalCommands } from './commands/approvals.ts';
import { campaignCommands } from './commands/campaign.ts';
import { reviewCommands } from './commands/review.ts';
import { auditCommands } from './commands/audit.ts';
import { automationCommands } from './commands/automation.ts';
import { toolCommands } from './commands/tools.ts';

export interface Command {
  name: string;
  /** The invocation line shown in help, without the leading command name. */
  usage: string;
  summary: string;
  /**
   * `serve` blocks forever, so the store must not be closed out from under it.
   * Everything else releases it when the command returns.
   */
  holdsProcess?: boolean;
  run(ctx: Context, args: Args): Promise<number>;
}

/**
 * Every command in one list, in the order help prints them.
 *
 * Help text is generated from this rather than maintained beside it. The old
 * hand-written block had already drifted once - `economics` existed for weeks
 * without appearing in it - and a list that can disagree with the code will.
 */
export const COMMANDS: Command[] = [
  ...toolCommands,
  ...lifecycleCommands,
  ...approvalCommands,
  ...campaignCommands,
  ...reviewCommands,
  ...auditCommands,
  ...automationCommands,
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

const HEADER = `founder-labs-autopilot - autonomous Ads -> Voice -> Revenue loop

  node src/cli.ts <command> [options]

Commands`;

const FOOTER = `
Everything runs against mock providers unless FL_MODE=live and credentials are set.`;

/** Two columns, with the summary dropped to its own line when the usage is long. */
export function usageText(commands: Command[] = COMMANDS, column = 34): string {
  const lines = commands.map((c) => {
    const invocation = `  ${c.name}${c.usage ? ` ${c.usage}` : ''}`;
    return invocation.length < column
      ? `${invocation.padEnd(column)}${c.summary}`
      : `${invocation}\n${' '.repeat(column)}${c.summary}`;
  });
  return [HEADER, ...lines, FOOTER].join('\n');
}
