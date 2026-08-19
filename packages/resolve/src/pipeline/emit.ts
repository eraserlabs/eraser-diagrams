import type { ResolvedConnection, ResolvedElement, ResolvedEntity } from '@eraserlabs/protocol';
import { entityIsContainer } from './container.js';
import type { PipelineElement } from './element.js';

/** The resolved payload, already split by the kind the per-element pass classified. */
export interface ResolvedPayload {
  entities: ResolvedEntity[];
  connections: ResolvedConnection[];
}

/**
 * Transform post-pipeline element clones into the ResolvedElement shape (position fields + props),
 * bucketed by kind. The casts are the emission of a classification already proven upstream: the
 * registry's `x-schema-kind` decided the bucket, and the tag schema decided which core fields can
 * be present.
 */
export function buildResolvedPayload(
  elements: readonly PipelineElement[],
  containers: ReadonlySet<string>,
): ResolvedPayload {
  const entities: ResolvedEntity[] = [];
  const connections: ResolvedConnection[] = [];

  for (const { kind, element } of elements) {
    const {
      tag,
      id,
      x,
      y,
      width,
      height,
      containerId,
      isContainer: _isContainer,
      ...props
    } = element as {
      tag: ResolvedElement['tag'];
      id: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      containerId?: string | null;
      isContainer?: boolean;
    } & Record<string, unknown>;
    const el: ResolvedElement = { tag, id, props };

    if (typeof x === 'number') {
      el.x = x;
    }

    if (typeof y === 'number') {
      el.y = y;
    }

    if (kind === 'connection') {
      connections.push(el as ResolvedConnection);
      continue;
    }

    if (typeof width === 'number') {
      el.width = width;
    }

    if (typeof height === 'number') {
      el.height = height;
    }

    if (typeof containerId === 'string' || containerId === null) {
      el.containerId = containerId;
    }

    const entity = el as ResolvedEntity;

    if (entityIsContainer(element, tag, containers)) {
      entity.isContainer = true;
    }

    entities.push(entity);
  }

  return { entities, connections };
}
