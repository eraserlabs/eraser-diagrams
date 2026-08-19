export type JsonSchemaNode = Record<string, unknown>;

/**
 * The single traversal of a per-tag schema. Every schema-derived table — the runtime policy table,
 * the linter's content and style-bindable pointer sets, the boot-time schema check — is built from
 * this walk, so they can never disagree about which nodes exist or where they sit.
 *
 * Pointers are element-relative, with one `*` segment per array level; combiner branches share
 * their parent's pointer. Tuple `items` (an array) are positional numbers and are not walked.
 */
export function walkSchema(
  schema: object,
  visit: (node: JsonSchemaNode, pointer: string) => void,
): void {
  visitNode(schema as JsonSchemaNode, '', visit);
}

function visitNode(
  node: JsonSchemaNode | undefined,
  pointer: string,
  visit: (node: JsonSchemaNode, pointer: string) => void,
): void {
  if (!node || typeof node !== 'object') {
    return;
  }

  visit(node, pointer);

  const props = node['properties'] as Record<string, JsonSchemaNode> | undefined;

  if (props) {
    for (const key of Object.keys(props)) {
      visitNode(props[key], `${pointer}/${escapePointer(key)}`, visit);
    }
  }

  const items = node['items'];

  if (items && !Array.isArray(items)) {
    visitNode(items as JsonSchemaNode, `${pointer}/*`, visit);
  }

  for (const combiner of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branch = node[combiner] as JsonSchemaNode[] | undefined;

    if (Array.isArray(branch)) {
      for (const sub of branch) {
        visitNode(sub, pointer, visit);
      }
    }
  }
}

function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}
