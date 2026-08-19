import type { LayoutEntity } from '../../types.js';
import type { RouteSearchRequest } from '../corridor/contract.js';
import { buildFreeSpaceSubstrate } from '../corridor/freeSpaceSubstrate.js';
import { planLandingZones } from '../corridor/landingZones.js';
import type { PositionProps } from '../../types.js';

const bounds = { x: -20, y: -20, width: 400, height: 240 };
const entities: LayoutEntity[] = [
  { id: 'from', x: 0, y: 20, width: 40, height: 80 },
  { id: 'to', x: 300, y: 140, width: 40, height: 60 },
];
const request: RouteSearchRequest = {
  requestIndex: 0,
  from: { entityIndex: 0, face: 'right' },
  to: { entityIndex: 1, face: 'left' },
};

function plan(
  planBounds: PositionProps,
  planEntities: LayoutEntity[],
  requests: RouteSearchRequest[],
) {
  return planLandingZones(
    planBounds,
    planEntities,
    requests,
    buildFreeSpaceSubstrate(planBounds, planEntities),
  );
}

describe('routing corridor external-caption obstacles', () => {
  const captioned: LayoutEntity = {
    id: 'captioned',
    x: 0,
    y: 0,
    width: 50,
    height: 50,
    textPlacement: { relativeX: 10, relativeY: 55, width: 20, height: 24 },
  };

  it('keeps the outward caption depth on only the caption/body cross-span', () => {
    const substrate = buildFreeSpaceSubstrate({ x: -100, y: -100, width: 300, height: 300 }, [
      captioned,
    ]);

    expect([...substrate.x.travelCuts]).toEqual([-100, 0, 10, 30, 50, 200]);
    expect([...substrate.y.travelCuts]).toEqual([-100, 0, 50, 79, 200]);
  });

  it('lets a neighboring face use the body span left uncovered by a narrow caption', () => {
    const planEntities: LayoutEntity[] = [
      { id: 'source', x: 0, y: 155, width: 40, height: 20 },
      {
        id: 'captioned',
        x: 100,
        y: 100,
        width: 50,
        height: 50,
        textPlacement: { relativeX: 20, relativeY: 55, width: 10, height: 20 },
      },
      { id: 'target', x: 300, y: 155, width: 40, height: 20 },
    ];
    const construction = plan({ x: -20, y: -20, width: 380, height: 240 }, planEntities, [
      {
        requestIndex: 0,
        from: { entityIndex: 0, face: 'right' },
        to: { entityIndex: 2, face: 'left' },
      },
    ]);

    expect(construction).toContainEqual({
      x: 40,
      y: 155,
      width: 80,
      height: 20,
      axis: 'x',
    });
  });
});

describe('routing corridor landing-zone substrate reuse', () => {
  it('skips the runway claim when certified free space runs outward past the preferred depth', () => {
    const construction = plan(bounds, entities, [request]);

    expect(construction).toEqual([]);
  });

  it('reuses a band exactly bounded to the face span', () => {
    const flanked: LayoutEntity[] = [
      { id: 'from', x: 0, y: 20, width: 40, height: 80 },
      { id: 'top', x: 40, y: 0, width: 220, height: 20 },
      { id: 'bottom', x: 40, y: 100, width: 220, height: 20 },
      { id: 'to', x: 300, y: 20, width: 40, height: 80 },
    ];
    const construction = plan(bounds, flanked, [request]);

    // The flanked from-face reuses the certified band exactly bounded by its neighbors;
    // only the short top-left target face still claims a dedicated runway.
    expect(construction).toEqual([{ x: -20, y: 0, width: 60, height: 20, axis: 'x' }]);
  });

  it('keeps a dedicated zone when the outward run is too shallow', () => {
    const blocked: LayoutEntity[] = [
      { id: 'from', x: 0, y: 20, width: 40, height: 80 },
      { id: 'blocker', x: 80, y: 0, width: 40, height: 120 },
      { id: 'to', x: 300, y: 140, width: 40, height: 60 },
    ];
    const construction = plan(bounds, blocked, [request]);

    expect(construction).toContainEqual({
      x: 40,
      y: 20,
      width: 20,
      height: 80,
      axis: 'x',
    });
  });

  it('lets a contained opposing face consume slack left by a shallow wider-face zone', () => {
    const nestedEntities: LayoutEntity[] = [
      { id: 'wide', x: 0, y: 0, width: 200, height: 50 },
      { id: 'narrow', x: 0, y: 123, width: 100, height: 50 },
      { id: 'other', x: 120, y: 127, width: 80, height: 50 },
    ];
    const nestedRequests: RouteSearchRequest[] = [
      {
        requestIndex: 0,
        from: { entityIndex: 0, face: 'down' },
        to: { entityIndex: 1, face: 'up' },
      },
      {
        requestIndex: 1,
        from: { entityIndex: 0, face: 'down' },
        to: { entityIndex: 2, face: 'up' },
      },
    ];

    const construction = plan(
      { x: -20, y: -20, width: 240, height: 220 },
      nestedEntities,
      nestedRequests,
    );

    expect(construction).toContainEqual({
      x: 0,
      y: 50,
      width: 200,
      height: 40,
      axis: 'y',
    });
    expect(construction).toContainEqual({
      x: 0,
      y: 50,
      width: 100,
      height: 73,
      axis: 'y',
    });
  });

  it('keeps the half-gap split when minimum landing zones already meet', () => {
    const nestedEntities: LayoutEntity[] = [
      { id: 'wide', x: 0, y: 0, width: 200, height: 50 },
      { id: 'narrow', x: 0, y: 70, width: 100, height: 50 },
    ];
    const nestedRequests: RouteSearchRequest[] = [
      {
        requestIndex: 0,
        from: { entityIndex: 0, face: 'down' },
        to: { entityIndex: 1, face: 'up' },
      },
      {
        requestIndex: 1,
        from: { entityIndex: 0, face: 'down' },
        to: { entityIndex: 1, face: 'up' },
      },
    ];

    const construction = plan(
      { x: -20, y: -20, width: 240, height: 180 },
      nestedEntities,
      nestedRequests,
    );

    expect(construction).toContainEqual({
      x: 0,
      y: 50,
      width: 200,
      height: 10,
      axis: 'y',
    });
    expect(construction).toContainEqual({
      x: 0,
      y: 60,
      width: 100,
      height: 10,
      axis: 'y',
    });
  });
});
