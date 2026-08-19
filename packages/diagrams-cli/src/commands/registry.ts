import { CliError } from '../errors.js';
import { configFor, printConfigRequested, resolverFor, type CommandInput } from '../shared.js';

export async function runRegistry(input: CommandInput): Promise<number> {
  const config = configFor(input.flags, {});

  if (printConfigRequested(input.flags, config)) {
    return 0;
  }

  const resolver = await resolverFor(config);
  process.stdout.write(`${JSON.stringify(resolver.registryInfo(), null, 2)}\n`);

  return 0;
}

export async function runSchema(input: CommandInput): Promise<number> {
  const config = configFor(input.flags, {});

  if (printConfigRequested(input.flags, config)) {
    return 0;
  }

  const [tag, extra] = input.positionals;

  if (tag === undefined || extra !== undefined) {
    throw new CliError('schema needs exactly one tag name.');
  }

  const resolver = await resolverFor(config);
  const schema = resolver.tagSchema(tag);

  if (schema === undefined) {
    const known = resolver
      .registryInfo()
      .tags.map((info) => info.tag)
      .join(', ');

    throw new CliError(`Unknown tag "${tag}". Known tags: ${known}.`);
  }

  process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);

  return 0;
}
