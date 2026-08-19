import { parseArgs } from 'node:util';
import { CliError } from './errors.js';

export const COMMANDS = ['render', 'validate', 'registry', 'schema', 'init'] as const;
export type Command = (typeof COMMANDS)[number];

export type Flags = Record<string, string | boolean | undefined>;

export interface ParsedArgs {
  command: Command | null;
  positionals: string[];
  flags: Flags;
  help: boolean;
  version: boolean;
}

type OptionTable = Record<string, { type: 'string' | 'boolean'; short?: string }>;

const CONFIG_OPTIONS: OptionTable = {
  config: { type: 'string', short: 'c' },
  'no-config': { type: 'boolean' },
  'print-config': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const REPORT_OPTIONS: OptionTable = {
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  debug: { type: 'boolean' },
  'fail-on-warning': { type: 'boolean' },
};

const RENDER_OPTIONS: OptionTable = {
  out: { type: 'string', short: 'o' },
  'out-dir': { type: 'string' },
  format: { type: 'string', short: 'f' },
  scale: { type: 'string' },
  pages: { type: 'string' },
  'chromium-path': { type: 'string' },
  fonts: { type: 'string' },
  'icon-base-url': { type: 'string' },
  'icon-cache-dir': { type: 'string' },
  'unknown-icon': { type: 'string' },
};

const OPTIONS_BY_COMMAND: Record<Command, OptionTable> = {
  render: { ...CONFIG_OPTIONS, ...REPORT_OPTIONS, ...RENDER_OPTIONS },
  validate: { ...CONFIG_OPTIONS, ...REPORT_OPTIONS },
  registry: { ...CONFIG_OPTIONS },
  schema: { ...CONFIG_OPTIONS },
  init: { ...CONFIG_OPTIONS, force: { type: 'boolean' }, 'chromium-path': { type: 'string' } },
};

export const USAGE = `Usage: eraser-diagrams <command> [options]

Commands:
  render <input...>     Render diagram JSON to PNG or HTML (needs Chromium)
  validate <input...>   Validate diagram JSON without a browser
  registry              Print the tag registry (JSON)
  schema <tag>          Print the JSON Schema of one tag
  init                  Write eraser-diagrams.config.json in the current directory

Global options:
  -c, --config <path>   Config file (default: nearest eraser-diagrams.config.json, or $ERASER_DIAGRAMS_CONFIG)
      --no-config       Ignore config files
      --print-config    Print the effective configuration and exit
  -h, --help            Show help for a command
  -v, --version         Print versions

<input> is a file path or "-" for stdin. Inputs starting with "-" go after "--".
Run "eraser-diagrams <command> --help" for command options.`;

const COMMAND_HELP: Record<Command, string> = {
  render: `Usage: eraser-diagrams render <input...> [options]

Options:
  -o, --out <path>            Output file for a single input ("-" writes bytes to stdout)
      --out-dir <dir>         Output directory (default: current directory); files are named <input>.<format>
  -f, --format png|html       Output format (default: png)
      --scale <n>             Pixel density for PNG (deviceScaleFactor, default: 1)
      --pages <n>             Warm Chromium page pool size (default: 1)
      --chromium-path <path>  Chromium executable (default: $CHROMIUM_PATH, config, then auto-detect)
      --fonts <path>          Fonts config JSON file
      --icon-base-url <url>   Icon host base URL
      --icon-cache-dir <dir>  On-disk icon cache directory
      --unknown-icon placeholder|error
                              Unknown icon policy (default: placeholder)
      --json                  Machine-readable report on stdout
      --fail-on-warning       Exit 1 when any warning is reported
  -q, --quiet                 No per-input status lines
      --debug                 Stage timings and provenance on stderr
${globalOptionsHelp()}`,
  validate: `Usage: eraser-diagrams validate <input...> [options]

Options:
      --json                  Machine-readable report on stdout
      --fail-on-warning       Exit 1 when any warning is reported
  -q, --quiet                 No per-input status lines
      --debug                 Provenance on stderr
${globalOptionsHelp()}`,
  registry: `Usage: eraser-diagrams registry [options]

Prints { tags: [{ tag, kind, requiredProps }] } as JSON on stdout.
${globalOptionsHelp()}`,
  schema: `Usage: eraser-diagrams schema <tag> [options]

Prints the compiled JSON Schema of one tag on stdout.
${globalOptionsHelp()}`,
  init: `Usage: eraser-diagrams init [options]

Writes eraser-diagrams.config.json in the current directory.

Options:
      --chromium-path <path>  Chromium executable to pin (default: $CHROMIUM_PATH, then auto-detect)
      --force                 Overwrite an existing file
${globalOptionsHelp()}`,
};

function globalOptionsHelp(): string {
  return `
Global options:
  -c, --config <path>         Config file (default: nearest eraser-diagrams.config.json, or $ERASER_DIAGRAMS_CONFIG)
      --no-config             Ignore config files
      --print-config          Print the effective configuration and exit
  -h, --help                  Show this help`;
}

export function helpFor(command: Command | null): string {
  return command ? COMMAND_HELP[command] : USAGE;
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const [first, ...rest] = argv;

  if (first === undefined || first === '--help' || first === '-h') {
    return { command: null, positionals: [], flags: {}, help: true, version: false };
  }

  if (first === '--version' || first === '-v') {
    return { command: null, positionals: [], flags: {}, help: false, version: true };
  }

  if (!isCommand(first)) {
    throw new CliError(`Unknown command "${first}".\n\n${USAGE}`);
  }

  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: OPTIONS_BY_COMMAND[first],
      strict: true,
      allowPositionals: true,
    });

    return {
      command: first,
      positionals,
      flags: values as Flags,
      help: values['help'] === true,
      version: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new CliError(`${message}\n\nRun "eraser-diagrams ${first} --help" for options.`);
  }
}

export function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];

  return typeof value === 'string' ? value : undefined;
}

export function booleanFlag(flags: Flags, name: string): boolean {
  return flags[name] === true;
}

/** Positive finite number, or a usage error naming the flag. */
export function numberFlag(flags: Flags, name: string): number | undefined {
  const raw = stringFlag(flags, name);

  if (raw === undefined) {
    return undefined;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError(`--${name} expects a positive number, got "${raw}".`);
  }

  return value;
}

export function choiceFlag<T extends string>(
  flags: Flags,
  name: string,
  choices: readonly T[],
): T | undefined {
  const raw = stringFlag(flags, name);

  if (raw === undefined) {
    return undefined;
  }

  if (!(choices as readonly string[]).includes(raw)) {
    throw new CliError(`--${name} expects one of ${choices.join('|')}, got "${raw}".`);
  }

  return raw as T;
}
