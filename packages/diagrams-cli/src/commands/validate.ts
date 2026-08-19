import { readInput } from '../inputs.js';
import { buildReport, type InputResult } from '../report.js';
import {
  commonOverrides,
  configFor,
  debugLine,
  emitReport,
  inputIssue,
  printConfigRequested,
  reportOptionsFor,
  requireInputs,
  resolverFor,
  type CommandInput,
} from '../shared.js';

export async function runValidate(input: CommandInput): Promise<number> {
  const config = configFor(input.flags, commonOverrides(input.flags));

  if (printConfigRequested(input.flags, config)) {
    return 0;
  }

  const specs = requireInputs(input, 'validate');
  const options = reportOptionsFor(input.flags, config);

  if (options.debug) {
    debugLine(`config: ${config.configPath ?? '(none)'}`);
  }

  const resolver = await resolverFor(config);
  const results: InputResult[] = [];

  for (const spec of specs) {
    const read = readInput(spec);

    if (!read.ok) {
      results.push({ input: spec, ok: false, errors: [inputIssue(read.message)], warnings: [] });
      continue;
    }

    if (read.unwrapped && !options.quiet) {
      process.stderr.write(`note  ${spec}: unwrapped { definition: { elements } } export\n`);
    }

    const result = await resolver.validate(read.document);
    results.push({ input: spec, ok: result.ok, errors: result.errors, warnings: result.warnings });
  }

  const report = buildReport(results, [], config.failOnWarning);
  emitReport(report, input.flags, options);

  return report.ok ? 0 : 1;
}
