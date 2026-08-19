import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { booleanFlag, stringFlag } from '../args.js';
import { detectChromium, hostDetectInput } from '../chromium.js';
import { CHROMIUM_ENV, CONFIG_FILE_NAME } from '../config.js';
import { CliError } from '../errors.js';
import { configFor, printConfigRequested, type CommandInput } from '../shared.js';

/** Writes a minimal config that pins the Chromium executable this machine will use. */
export function runInit(input: CommandInput): number {
  if (printConfigRequested(input.flags, configFor(input.flags, {}))) {
    return 0;
  }

  const cwd = process.cwd();
  const configFlag = stringFlag(input.flags, 'config');
  const target = configFlag !== undefined ? resolve(cwd, configFlag) : join(cwd, CONFIG_FILE_NAME);

  if (existsSync(target) && !booleanFlag(input.flags, 'force')) {
    throw new CliError(`${target} already exists; pass --force to overwrite it.`);
  }

  const chromiumPath =
    stringFlag(input.flags, 'chromium-path') ??
    process.env[CHROMIUM_ENV] ??
    detectChromium(hostDetectInput());
  const config = chromiumPath ? { chromiumPath } : {};

  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  process.stderr.write(
    chromiumPath
      ? `Wrote ${target} (chromiumPath: ${chromiumPath})\n`
      : `Wrote ${target}. No Chromium found; add "chromiumPath" before rendering.\n`,
  );

  return 0;
}
