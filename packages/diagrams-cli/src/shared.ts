import {
  createResolver,
  ERROR_CODE,
  RegistryError,
  SchemaDefinitionError,
  SEVERITY,
  type Issue,
  type Resolver,
} from '@eraserlabs/resolve';
import { booleanFlag, stringFlag, type Flags } from './args.js';
import { resolveConfig, type ConfigOverrides, type EffectiveConfig } from './config.js';
import { CliError } from './errors.js';
import { formatHuman, formatJson, type Report, type ReportOptions } from './report.js';
import { resolverSetupFrom } from './setup.js';

export interface CommandInput {
  positionals: string[];
  flags: Flags;
}

/** Config for the current invocation; `--print-config` short-circuits the command (exit 0). */
export function configFor(flags: Flags, overrides: ConfigOverrides): EffectiveConfig {
  const configFlag = stringFlag(flags, 'config');

  return resolveConfig({
    cwd: process.cwd(),
    env: process.env,
    flags: overrides,
    ...(configFlag !== undefined ? { configFlag } : {}),
    noConfig: booleanFlag(flags, 'no-config'),
  });
}

export function printConfigRequested(flags: Flags, config: EffectiveConfig): boolean {
  if (!booleanFlag(flags, 'print-config')) {
    return false;
  }

  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);

  return true;
}

/** Overrides every command shares: `--fail-on-warning`. */
export function commonOverrides(flags: Flags): ConfigOverrides {
  return {
    ...(booleanFlag(flags, 'fail-on-warning') ? { failOnWarning: true } : {}),
  };
}

export function reportOptionsFor(flags: Flags, config: EffectiveConfig): ReportOptions {
  return {
    quiet: booleanFlag(flags, 'quiet'),
    debug: booleanFlag(flags, 'debug'),
    failOnWarning: config.failOnWarning,
  };
}

/** Human report to stderr, or the machine report to stdout under `--json`. */
export function emitReport(report: Report, flags: Flags, options: ReportOptions): void {
  if (booleanFlag(flags, 'json')) {
    process.stdout.write(formatJson(report));

    return;
  }

  process.stderr.write(formatHuman(report, options));
}

export function debugLine(text: string): void {
  process.stderr.write(`debug ${text}\n`);
}

/** Boot-time library problems (`RegistryError`) are invocation errors, not diagram errors. */
export async function resolverFor(config: EffectiveConfig): Promise<Resolver> {
  try {
    return await createResolver(await resolverSetupFrom(config));
  } catch (error) {
    if (error instanceof RegistryError || error instanceof SchemaDefinitionError) {
      throw new CliError(error.message);
    }

    throw error;
  }
}

export function requireInputs(input: CommandInput, command: string): string[] {
  if (input.positionals.length === 0) {
    throw new CliError(`${command} needs at least one input file (or "-" for stdin).`);
  }

  return input.positionals;
}

/** An unreadable or unparseable input is a per-input failure with a transport-level code. */
export function inputIssue(message: string): Issue {
  return { code: ERROR_CODE.BAD_JSON, severity: SEVERITY.ERROR, path: '/', message };
}
