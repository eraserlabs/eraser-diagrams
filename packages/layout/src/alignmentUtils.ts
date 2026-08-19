// ===========================================================================
// Explicitly captured, level-aware alignment
// ===========================================================================

import type { Axis, LayoutEntity } from './types.js';

export type EdgeKind = 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY';

export interface AlignmentClass {
  kind: EdgeKind;
  value: number;
  ids: readonly string[];
}

export interface AlignmentView {
  classes: readonly AlignmentClass[];
  /** entityId -> kind -> the multi-member class it belongs to (singletons omitted). */
  byEntity: ReadonlyMap<string, Partial<Record<EdgeKind, AlignmentClass>>>;
}

export interface AlignmentCaptureOptions {
  entities?: readonly LayoutEntity[];
  tolerance?: number;
}

const EMPTY_CLASSES: AlignmentClass[] = [];
const EMPTY_BY_ENTITY = new Map<string, Partial<Record<EdgeKind, AlignmentClass>>>();

/**
 * Alignment is captured explicitly and remains stable while geometry mutates.
 * Call `capture()` again only at a layout boundary, such as after a completed
 * user gesture or before a new reconciliation transaction.
 */
export class LayoutAlignment {
  private captured: AlignmentView | undefined;

  constructor(
    private readonly currentEntities: () => readonly LayoutEntity[],
    captured?: AlignmentView,
  ) {
    this.captured = captured;
  }

  capture(options: AlignmentCaptureOptions = {}): AlignmentView {
    this.captured = buildAlignmentView(
      options.entities ?? this.currentEntities(),
      options.tolerance ?? 1,
    );
    return this.captured;
  }

  clear(): void {
    this.captured = undefined;
  }

  get isCaptured(): boolean {
    return this.captured !== undefined;
  }

  get classes(): readonly AlignmentClass[] {
    return this.captured?.classes ?? EMPTY_CLASSES;
  }

  get byEntity(): ReadonlyMap<string, Partial<Record<EdgeKind, AlignmentClass>>> {
    return this.captured?.byEntity ?? EMPTY_BY_ENTITY;
  }

  copyFor(currentEntities: () => readonly LayoutEntity[]): LayoutAlignment {
    return new LayoutAlignment(currentEntities, this.captured);
  }
}

/**
 * Build a level-aware alignment partition of one stable geometry frame.
 *
 * Same-scope entities couple on a shared edge or center. Across scopes, an
 * entity is admitted only when both edges on the axis match that other scope,
 * which preserves congruent/spanning intent without welding coincidental edges.
 */
export function buildAlignmentView(
  entities: readonly LayoutEntity[],
  tolerance = 1,
): AlignmentView {
  const round = (value: number) => Math.round(value / tolerance) * tolerance;
  const edged: EdgeEntity[] = entities.map((entity) => ({
    id: entity.id,
    scope: entity.containerId ?? '__root__',
    start: { x: round(entity.x), y: round(entity.y) },
    end: { x: round(entity.x + entity.width), y: round(entity.y + entity.height) },
    center: { x: round(entity.x + entity.width / 2), y: round(entity.y + entity.height / 2) },
  }));

  const scopeStarts = new Map<string, Record<Axis, Set<number>>>();
  const scopeEnds = new Map<string, Record<Axis, Set<number>>>();
  for (const entity of edged) {
    const starts = getOrInit(scopeStarts, entity.scope);
    const ends = getOrInit(scopeEnds, entity.scope);
    for (const axis of ['x', 'y'] as const) {
      starts[axis].add(entity.start[axis]);
      ends[axis].add(entity.end[axis]);
    }
  }

  const crossAdmitted = (entity: EdgeEntity, scope: string, axis: Axis): boolean =>
    (scopeStarts.get(scope)?.[axis].has(entity.start[axis]) ?? false) &&
    (scopeEnds.get(scope)?.[axis].has(entity.end[axis]) ?? false);

  const classes: AlignmentClass[] = [];

  for (const axis of ['x', 'y'] as const) {
    for (const side of ['start', 'end'] as const) {
      const kind = side === 'start' ? START_KIND[axis] : END_KIND[axis];
      const byValue = new Map<number, EdgeEntity[]>();
      for (const entity of edged) {
        const value = entity[side][axis];
        const bucket = byValue.get(value) ?? [];
        bucket.push(entity);
        byValue.set(value, bucket);
      }
      for (const [value, bucket] of byValue) {
        if (bucket.length < 2) {
          continue;
        }
        for (const component of splitBucketIntoComponents(bucket, axis, crossAdmitted)) {
          if (component.length > 1) {
            classes.push({ kind, value, ids: component.map((entity) => entity.id).sort() });
          }
        }
      }
    }

    const kind = CENTER_KIND[axis];
    const byScopeValue = new Map<string, EdgeEntity[]>();
    for (const entity of edged) {
      const key = `${entity.scope}:${entity.center[axis]}`;
      const bucket = byScopeValue.get(key) ?? [];
      bucket.push(entity);
      byScopeValue.set(key, bucket);
    }
    for (const bucket of byScopeValue.values()) {
      if (bucket.length > 1) {
        classes.push({
          kind,
          value: bucket[0].center[axis],
          ids: bucket.map((entity) => entity.id).sort(),
        });
      }
    }
  }

  const byEntity = new Map<string, Partial<Record<EdgeKind, AlignmentClass>>>();
  for (const alignmentClass of classes) {
    for (const id of alignmentClass.ids) {
      const entry = byEntity.get(id) ?? {};
      entry[alignmentClass.kind] = alignmentClass;
      byEntity.set(id, entry);
    }
  }

  return { classes, byEntity };
}

const START_KIND: Record<Axis, EdgeKind> = { x: 'left', y: 'top' };
const END_KIND: Record<Axis, EdgeKind> = { x: 'right', y: 'bottom' };
const CENTER_KIND: Record<Axis, EdgeKind> = { x: 'centerX', y: 'centerY' };

interface EdgeEntity {
  id: string;
  scope: string;
  start: Record<Axis, number>;
  end: Record<Axis, number>;
  center: Record<Axis, number>;
}

function splitBucketIntoComponents(
  bucket: EdgeEntity[],
  axis: Axis,
  crossAdmitted: (entity: EdgeEntity, scope: string, axis: Axis) => boolean,
): EdgeEntity[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };
  for (const entity of bucket) {
    parent.set(entity.id, entity.id);
  }

  for (let i = 0; i < bucket.length; i++) {
    for (let j = i + 1; j < bucket.length; j++) {
      const a = bucket[i];
      const b = bucket[j];
      const coupled =
        a.scope === b.scope || crossAdmitted(a, b.scope, axis) || crossAdmitted(b, a.scope, axis);
      if (coupled) {
        union(a.id, b.id);
      }
    }
  }

  const components = new Map<string, EdgeEntity[]>();
  for (const entity of bucket) {
    const root = find(entity.id);
    const list = components.get(root) ?? [];
    list.push(entity);
    components.set(root, list);
  }
  return [...components.values()];
}

function getOrInit(map: Map<string, Record<Axis, Set<number>>>, scope: string) {
  let entry = map.get(scope);
  if (!entry) {
    entry = { x: new Set(), y: new Set() };
    map.set(scope, entry);
  }
  return entry;
}
