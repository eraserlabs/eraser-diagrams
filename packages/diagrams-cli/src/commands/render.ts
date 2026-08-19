import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  createRenderer,
  type OutputRequest,
  type Renderer,
  type RenderRequest,
} from '@eraserlabs/diagrams';
import { RegistryError, SchemaDefinitionError } from '@eraserlabs/resolve';
import { booleanFlag, choiceFlag, numberFlag, stringFlag, type Flags } from '../args.js';
import { chromiumCandidates, detectChromium, hostDetectInput } from '../chromium.js';
import {
  CHROMIUM_ENV,
  OUTPUT_FORMATS,
  UNKNOWN_ICON_POLICIES,
  type ConfigOverrides,
  type EffectiveConfig,
  type IconsConfig,
} from '../config.js';
import { CliError } from '../errors.js';
import { outputName, readInput, STDIN, type InputRead } from '../inputs.js';
import { buildReport, formatTimings, type InputResult } from '../report.js';
import { rendererOptionsFrom } from '../setup.js';
import {
  commonOverrides,
  configFor,
  debugLine,
  emitReport,
  inputIssue,
  printConfigRequested,
  reportOptionsFor,
  requireInputs,
  type CommandInput,
} from '../shared.js';

function renderOverrides(flags: Flags): ConfigOverrides {
  const chromiumPath = stringFlag(flags, 'chromium-path');
  const format = choiceFlag(flags, 'format', OUTPUT_FORMATS);
  const outDir = stringFlag(flags, 'out-dir');
  const deviceScaleFactor = numberFlag(flags, 'scale');
  const pages = numberFlag(flags, 'pages');
  const fonts = stringFlag(flags, 'fonts');
  const baseUrl = stringFlag(flags, 'icon-base-url');
  const cacheDir = stringFlag(flags, 'icon-cache-dir');
  const onUnknown = choiceFlag(flags, 'unknown-icon', UNKNOWN_ICON_POLICIES);
  const icons: IconsConfig = {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(cacheDir !== undefined ? { cacheDir } : {}),
    ...(onUnknown !== undefined ? { onUnknown } : {}),
  };

  return {
    ...commonOverrides(flags),
    ...(chromiumPath !== undefined ? { chromiumPath } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(outDir !== undefined ? { outDir } : {}),
    ...(deviceScaleFactor !== undefined ? { deviceScaleFactor } : {}),
    ...(pages !== undefined ? { pages: Math.round(pages) } : {}),
    ...(fonts !== undefined ? { fonts } : {}),
    ...(Object.keys(icons).length > 0 ? { icons } : {}),
  };
}

function chromiumFor(config: EffectiveConfig, quiet: boolean): string {
  if (config.chromiumPath !== undefined) {
    return config.chromiumPath;
  }

  const detect = hostDetectInput();
  const detected = detectChromium(detect);

  if (detected !== undefined) {
    if (!quiet) {
      process.stderr.write(
        `Using Chromium: ${detected} (auto-detected — set chromiumPath to pin it)\n`,
      );
    }

    return detected;
  }

  const probed = chromiumCandidates(detect)
    .map((candidate) => `  ${candidate}`)
    .join('\n');

  throw new CliError(
    `Rendering requires Chromium. Pass --chromium-path, set ${CHROMIUM_ENV}, or set "chromiumPath" in eraser-diagrams.config.json (eraser-diagrams init writes one).\nProbed:\n${probed}`,
  );
}

async function bootRenderer(config: EffectiveConfig, chromiumPath: string): Promise<Renderer> {
  try {
    return await createRenderer(await rendererOptionsFrom(config, chromiumPath));
  } catch (error) {
    if (error instanceof RegistryError || error instanceof SchemaDefinitionError) {
      throw new CliError(error.message);
    }

    throw error;
  }
}

function writeStdout(data: string | Buffer): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    process.stdout.write(data, (error) => (error ? reject(error) : resolvePromise()));
  });
}

async function writeOutput(target: string, data: string | Buffer): Promise<void> {
  if (target === STDIN) {
    await writeStdout(data);

    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
}

/** Paths under cwd print relative; anything else stays absolute. */
function displayPath(target: string): string {
  const rel = relative(process.cwd(), target);

  return rel.startsWith('..') ? target : rel;
}

interface RenderJob {
  spec: string;
  read: InputRead;
}

function failedRead(spec: string, message: string): InputResult {
  return { input: spec, ok: false, errors: [inputIssue(message)], warnings: [] };
}

/**
 * The document a file holds is the render request, with `--format` supplying `outputs`. A document
 * is always an object envelope, so an array — which has nowhere to put `outputs` anyway — is not
 * wrapped here: it flows through untouched and the engine answers with `E_ENVELOPE`.
 */
function renderRequestFrom<const O extends OutputRequest>(
  document: unknown,
  outputs: O,
): RenderRequest & { outputs: O } {
  if (document && typeof document === 'object' && !Array.isArray(document)) {
    return { ...(document as object), outputs } as RenderRequest & { outputs: O };
  }

  // Not a document at all: hand it over untouched so resolve answers with the envelope error.
  return document as RenderRequest & { outputs: O };
}

async function renderOne(
  renderer: Renderer,
  spec: string,
  document: unknown,
  config: EffectiveConfig,
  outFlag: string | undefined,
): Promise<InputResult> {
  const started = performance.now();
  const outcome =
    config.format === 'html'
      ? await renderer.render(renderRequestFrom(document, { html: true }))
      : await renderer.render(renderRequestFrom(document, { png: true }));

  if (!outcome.ok) {
    return { input: spec, ok: false, errors: outcome.errors, warnings: outcome.warnings };
  }

  const target =
    outFlag === STDIN
      ? STDIN
      : outFlag !== undefined
        ? resolve(process.cwd(), outFlag)
        : join(config.outDir, outputName(spec, config.format));
  await writeOutput(target, 'html' in outcome ? outcome.html : outcome.png);

  return {
    input: spec,
    ...(target === STDIN ? {} : { out: displayPath(target) }),
    ok: true,
    errors: [],
    warnings: outcome.warnings,
    ms: Math.round(performance.now() - started),
    timingsMs: outcome.timingsMs,
  };
}

export async function runRender(input: CommandInput): Promise<number> {
  const config = configFor(input.flags, renderOverrides(input.flags));

  if (printConfigRequested(input.flags, config)) {
    return 0;
  }

  const specs = requireInputs(input, 'render');
  const outFlag = stringFlag(input.flags, 'out');
  const options = reportOptionsFor(input.flags, config);

  if (outFlag !== undefined && specs.length > 1) {
    throw new CliError('--out takes exactly one input; use --out-dir to render several.');
  }

  if (outFlag === STDIN && booleanFlag(input.flags, 'json')) {
    throw new CliError('--json and "-o -" both write to stdout; pick one.');
  }

  const jobs: RenderJob[] = specs.map((spec) => ({ spec, read: readInput(spec) }));

  if (options.debug) {
    debugLine(`config: ${config.configPath ?? '(none)'}`);
  }

  if (!jobs.some((job) => job.read.ok)) {
    const failures = jobs.flatMap((job) =>
      job.read.ok ? [] : [failedRead(job.spec, job.read.message)],
    );
    const report = buildReport(failures, [], config.failOnWarning);
    emitReport(report, input.flags, options);

    return 1;
  }

  const chromiumPath = chromiumFor(config, options.quiet);

  if (options.debug) {
    debugLine(`chromium: ${chromiumPath} (${config.chromiumSource ?? 'auto-detected'})`);
  }

  for (const job of jobs) {
    if (job.read.ok && job.read.unwrapped && !options.quiet) {
      process.stderr.write(`note  ${job.spec}: unwrapped { definition: { elements } } export\n`);
    }
  }

  const bootStart = performance.now();
  const renderer = await bootRenderer(config, chromiumPath);
  const bootMs = performance.now() - bootStart;

  const onSignal = (signal: NodeJS.Signals): void => {
    process.stderr.write(`\nReceived ${signal}; closing Chromium.\n`);
    void renderer.close().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let results: InputResult[];

  try {
    results = await Promise.all(
      jobs.map((job) =>
        job.read.ok
          ? renderOne(renderer, job.spec, job.read.document, config, outFlag)
          : Promise.resolve(failedRead(job.spec, job.read.message)),
      ),
    );
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await renderer.close();
  }

  const report = buildReport(results, renderer.degradedFonts, config.failOnWarning);
  emitReport(report, input.flags, options);

  if (options.debug) {
    process.stderr.write(formatTimings('Boot', { 'boot (chromium + pages + fonts)': bootMs }));

    for (const result of results) {
      if (result.timingsMs) {
        process.stderr.write(formatTimings(`Timings: ${result.input}`, result.timingsMs));
      }
    }
  }

  return report.ok ? 0 : 1;
}
