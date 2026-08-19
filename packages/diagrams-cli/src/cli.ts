#!/usr/bin/env node
import { createRequire } from 'node:module';
import { helpFor, parseCliArgs } from './args.js';
import { runInit } from './commands/init.js';
import { runRegistry, runSchema } from './commands/registry.js';
import { runRender } from './commands/render.js';
import { runValidate } from './commands/validate.js';
import { CliError } from './errors.js';

/** `eraser-diagrams <render|validate|registry|schema|init> [options]` */

const require = createRequire(import.meta.url);

function versionLine(): string {
  const own = require('../package.json') as { version: string };
  const diagrams = require('@eraserlabs/diagrams/package.json') as { version: string };

  return `@eraserlabs/diagrams-cli ${own.version} (@eraserlabs/diagrams ${diagrams.version}, node ${process.version})\n`;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);

  if (parsed.version) {
    process.stdout.write(versionLine());

    return 0;
  }

  if (parsed.help || parsed.command === null) {
    process.stdout.write(`${helpFor(parsed.command)}\n`);

    return 0;
  }

  const input = { positionals: parsed.positionals, flags: parsed.flags };

  switch (parsed.command) {
    case 'render':
      return runRender(input);
    case 'validate':
      return runValidate(input);
    case 'registry':
      return runRegistry(input);
    case 'schema':
      return runSchema(input);
    case 'init':
      return runInit(input);
  }
}

// exitCode (not process.exit) so a piped stdout is flushed before the process ends.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : 2;
  },
);
