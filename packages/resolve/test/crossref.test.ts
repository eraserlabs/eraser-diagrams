import { describe, it, expect } from 'vitest';
import { stageCrossref } from '../src/pipeline/crossref.js';
import type { PipelineElement } from '../src/pipeline/element.js';
import { ERROR_CODE } from '../src/result-types.js';
import type { PolicyEntry } from '../src/types.js';

const POLICIES: Record<string, PolicyEntry[]> = {
  Node: [{ pointer: '/containerId', kind: 'ref' }],
  Wire: [
    { pointer: '/from', kind: 'ref' },
    { pointer: '/to', kind: 'ref' },
  ],
};
function node(id: string, index: number, containerId?: string): PipelineElement {
  return {
    index,
    path: `/${index}`,
    tag: 'Node',
    kind: 'entity',
    element: { id, ...(containerId === undefined ? {} : { containerId }) },
  };
}

function wire(id: string, index: number, from: unknown, to: unknown): PipelineElement {
  return { index, path: `/${index}`, tag: 'Wire', kind: 'connection', element: { id, from, to } };
}

function run(
  items: PipelineElement[],
  containers: ReadonlySet<string> = new Set(['Node']),
): ReturnType<typeof stageCrossref> {
  return stageCrossref(items, POLICIES, containers);
}

describe('crossref stage', () => {
  it('accepts a valid scene: containment chain plus a routed connection', () => {
    const { errors, warnings } = run([
      node('g', 0),
      node('a', 1, 'g'),
      node('b', 2, 'g'),
      wire('w', 3, 'a', 'b'),
    ]);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('reports a duplicate id at the second occurrence', () => {
    const { errors } = run([node('a', 0), node('a', 1)]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: ERROR_CODE.DUPLICATE_ID,
      path: '/1/id',
      elementIndex: 1,
      elementId: 'a',
    });
  });

  it('reports a dangling reference with its element-relative path', () => {
    const { errors } = run([node('a', 0), wire('w', 1, 'a', 'ghost')]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: ERROR_CODE.MISSING_REF,
      path: '/1/to',
      elementIndex: 1,
    });
  });

  it('rejects a reference that points at a connection instead of a node', () => {
    const { errors } = run([
      node('a', 0),
      node('b', 1),
      wire('w1', 2, 'a', 'b'),
      wire('w2', 3, 'a', 'w1'),
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: ERROR_CODE.REF_TO_CONNECTION, path: '/3/to' });
  });

  it('allows a self-referencing connection (self-loop arrows are legal)', () => {
    const { errors } = run([node('a', 0), wire('w', 1, 'a', 'a')]);

    expect(errors).toEqual([]);
  });

  it('rejects self-containment as a length-1 cycle', () => {
    const { errors } = run([node('a', 0, 'a')]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: ERROR_CODE.CONTAINER_CYCLE,
      path: '/0/containerId',
      elementId: 'a',
    });
  });

  it('reports every member of a containment cycle exactly once', () => {
    const { errors } = run([node('a', 0, 'b'), node('b', 1, 'a')]);

    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.code)).toEqual([
      ERROR_CODE.CONTAINER_CYCLE,
      ERROR_CODE.CONTAINER_CYCLE,
    ]);
    expect(errors.map((e) => e.elementId).sort()).toEqual(['a', 'b']);
  });

  it('does not blame an element whose chain merely leads into a foreign cycle', () => {
    const { errors } = run([node('a', 0, 'b'), node('b', 1, 'a'), node('c', 2, 'a')]);

    expect(errors.map((e) => e.elementId).sort()).toEqual(['a', 'b']);
  });

  it('skips non-string reference values (schema validation owns their type errors)', () => {
    const { errors } = run([node('a', 0), wire('w', 1, 42, 'a')]);

    expect(errors).toEqual([]);
  });

  it('rejects containment that names a non-container entity', () => {
    const { errors } = run([node('a', 0), node('b', 1, 'a')], new Set());

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: ERROR_CODE.NOT_CONTAINER,
      path: '/1/containerId',
      elementIndex: 1,
    });
  });

  it('accepts containment when the target authors isContainer', () => {
    const host: PipelineElement = {
      index: 0,
      path: '/0',
      tag: 'Node',
      kind: 'entity',
      element: { id: 'box', isContainer: true },
    };
    const { errors } = run([host, node('child', 1, 'box')], new Set());

    expect(errors).toEqual([]);
  });
});
