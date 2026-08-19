export interface PropRow {
  name: string;
  type: string;
  required: boolean;
  enum?: string[];
  default?: unknown;
  note?: string;
}

type JsonSchema = Record<string, unknown>;

const KEYWORD_NOTE: Record<string, string> = {
  'x-content': 'sanitized text',
  'x-css-color': 'css color',
  'x-icon-name': 'icon name',
  'x-ref': 'element reference',
  'x-palette': 'palette token or css color',
};

/** Derive a per-tag prop table from a tag's JSON Schema (from GET /registry/schema/:tag). */
export function propRows(schema: JsonSchema): PropRow[] {
  const props = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
  const required = new Set(
    ((schema.required as string[] | undefined) ?? []).filter((r) => r !== 'tag'),
  );

  return Object.entries(props)
    .filter(([name]) => name !== 'tag')
    .map(([name, def]) => {
      const row: PropRow = {
        name,
        type: typeOf(def),
        required: required.has(name),
      };
      const e = enumOf(def);

      if (e) {
        row.enum = e;
      }

      if ('default' in def) {
        row.default = def.default;
      }

      const note = noteOf(def);

      if (note) {
        row.note = note;
      }

      return row;
    });
}

function typeOf(def: JsonSchema): string {
  if (typeof def.const !== 'undefined') {
    return `const ${JSON.stringify(def.const)}`;
  }

  if (Array.isArray(def.enum)) {
    return 'enum';
  }

  if (def.type === 'array') {
    const items = def.items as JsonSchema | undefined;

    return `array<${items ? typeOf(items) : 'any'}>`;
  }

  if (Array.isArray(def.anyOf)) {
    return (def.anyOf as JsonSchema[]).map(typeOf).join(' | ');
  }

  if (typeof def.type === 'string') {
    return def.type;
  }

  if (def.type === 'object' || def.properties) {
    return 'object';
  }

  return 'any';
}

function enumOf(def: JsonSchema): string[] | undefined {
  if (Array.isArray(def.enum)) {
    return def.enum.map((v) => String(v));
  }

  return undefined;
}

function noteOf(def: JsonSchema): string | undefined {
  for (const [kw, note] of Object.entries(KEYWORD_NOTE)) {
    if (kw in def) {
      return note;
    }
  }

  return undefined;
}
