import { parseFragment } from 'parse5';
import type { TemplateFile } from '@eraserlabs/protocol';

export interface ParsedTemplate {
  file: TemplateFile;
  name: string;
  /** `data-tpl` value on the root content element. */
  dataTpl: string | undefined;
  roles: string[];
  /** `{{ head... }}` placeholder head tokens (the part before any `.`), '' for the empty placeholder. */
  placeholderHeads: string[];
  /** Placeholder heads inside attribute values (content-in-attribute forbids content-typed ones). */
  attrPlaceholderHeads: string[];
  /** Full dotted placeholder paths inside attribute values. */
  attrPlaceholderPaths: string[];
  /** Loop variables declared by `data-each="VAR of PROP"`. */
  loopVars: string[];
  /** Raw `data-each` expressions. */
  eachExpressions: { expr: string; hasKey: boolean }[];
  /** `data-use` targets. */
  useTargets: string[];
  /** Tag names used anywhere in the markup (lowercased). */
  usedTags: string[];
  /** Attribute names used anywhere (lowercased). */
  usedAttrs: string[];
}

type P5Node = {
  tagName?: string;
  nodeName: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5Node[];
  content?: { childNodes?: P5Node[] };
};

const PLACEHOLDER_RE = /\{\{\s*([^}]*?)\s*\}\}/g;

export function parseTemplate(file: TemplateFile): ParsedTemplate {
  const frag = parseFragment(file.html) as unknown as { childNodes: P5Node[] };
  const templateNode = frag.childNodes.find((n) => n.tagName === 'template');

  if (!templateNode) {
    throw new ParseError(file.name, 'no <template> element found');
  }

  const name = attr(templateNode, 'name') ?? '';

  const contentRoots = templateNode.content?.childNodes?.filter((n) => n.tagName) ?? [];
  const rootEl = contentRoots[0];
  const dataTpl = rootEl ? attr(rootEl, 'data-tpl') : undefined;

  const roles: string[] = [];
  const useTargets: string[] = [];
  const eachExpressions: { expr: string; hasKey: boolean }[] = [];
  const loopVars: string[] = [];
  const usedTags: string[] = [];
  const usedAttrs: string[] = [];
  const attrPlaceholderHeads: string[] = [];
  const attrPlaceholderPaths: string[] = [];

  const rootNodes = templateNode.content?.childNodes ?? [];

  for (const node of rootNodes) {
    walk(node, (el) => {
      usedTags.push((el.tagName ?? '').toLowerCase());

      for (const a of el.attrs ?? []) {
        usedAttrs.push(a.name.toLowerCase());

        for (const m of a.value.matchAll(PLACEHOLDER_RE)) {
          attrPlaceholderHeads.push(headOf(m[1] ?? ''));
          attrPlaceholderPaths.push((m[1] ?? '').trim());
        }

        if (a.name === 'data-role') {
          roles.push(a.value);
        } else if (a.name === 'data-use') {
          useTargets.push(a.value);
        } else if (a.name === 'data-each') {
          const m = /^\s*([A-Za-z_]\w*)\s+of\s+(.+?)\s*$/.exec(a.value);
          const hasKey = (el.attrs ?? []).some((x) => x.name === 'data-key');
          eachExpressions.push({ expr: a.value, hasKey });

          if (m) {
            loopVars.push(m[1]!);
          }
        }
      }
    });
  }

  const placeholderHeads = [...file.html.matchAll(PLACEHOLDER_RE)].map((m) => headOf(m[1] ?? ''));

  return {
    file,
    name,
    dataTpl,
    roles,
    placeholderHeads,
    attrPlaceholderHeads,
    attrPlaceholderPaths,
    loopVars,
    eachExpressions,
    useTargets,
    usedTags,
    usedAttrs,
  };
}

/** The head token of a placeholder body: the part before any `.` or `[`, '' for the empty placeholder. */
function headOf(inner: string): string {
  const trimmed = inner.trim();

  return trimmed === '' ? '' : trimmed.split('.')[0]!.split('[')[0]!;
}

export class ParseError extends Error {
  constructor(
    public template: string,
    reason: string,
  ) {
    super(`template "${template}": ${reason}`);
    this.name = 'ParseError';
  }
}

function walk(node: P5Node, visit: (el: P5Node) => void): void {
  if (node.tagName) {
    visit(node);
  }

  const kids = node.childNodes ?? node.content?.childNodes ?? [];

  for (const k of kids) {
    walk(k, visit);
  }
}

function attr(node: P5Node, name: string): string | undefined {
  return node.attrs?.find((a) => a.name === name)?.value;
}
