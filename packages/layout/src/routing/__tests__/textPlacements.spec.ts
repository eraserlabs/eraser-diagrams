import { LayoutManager } from '../../LayoutManager.js';
import { LayoutConnection, LayoutConnectionTextPlacementSource } from '../../types.js';
import { makeEntity } from '../../testUtils.js';
import { finalizeShiftRoute } from '../shiftRouting.js';
import type { RoutedConnectionChange } from '../types.js';
import {
  adjustLabelPositionOffSegment,
  LABEL_LINE_GAP,
  LABEL_OFF_SEGMENT_BUFFER,
  type CoordinateSegment,
  isLabelRectOnSegment,
  makeExternalTextRange,
  placeTextElement,
  resolveConnectionLabelRelativePlacement,
  touchExternalTextRangeToEntity,
  touchExternalTextRangeToEntityClippedToBodyFace,
} from '../textPlacements.js';

const SHORT_ROUTE_LABEL = { width: 60, height: 14 };
const SHORT_ROUTE_LINE = { x: 140, y: 2511.4, length: 30 };
const SHORT_ROUTE_EXPECTED = {
  textPlacement: { x: 125, y: 2493.4, width: 60, height: 14 },
  labelPlacement: { x: -15, y: -18 },
  labelCenter: { x: 155, y: 2500.4 },
};

describe('external entity text routing bounds', () => {
  const entity = {
    id: 'icon',
    x: 0,
    y: 0,
    width: 50,
    height: 50,
    textPlacement: { relativeX: -10, relativeY: 55, width: 70, height: 24 },
  };

  it('returns the external text range without changing its placement', () => {
    expect(makeExternalTextRange(entity)).toEqual({
      minX: -10,
      minY: 55,
      maxX: 60,
      maxY: 79,
    });
  });

  it('extends the blocker through the visual gap to the owning entity', () => {
    expect(touchExternalTextRangeToEntity(entity)).toEqual({
      x: -10,
      y: 50,
      width: 70,
      height: 29,
    });
  });

  it.each([
    [
      'above',
      { relativeX: -10, relativeY: -29, width: 70, height: 24 },
      { x: 0, y: -29, width: 50, height: 29 },
    ],
    [
      'right',
      { relativeX: 55, relativeY: -10, width: 24, height: 70 },
      { x: 50, y: 0, width: 29, height: 50 },
    ],
    [
      'below',
      { relativeX: -10, relativeY: 55, width: 70, height: 24 },
      { x: 0, y: 50, width: 50, height: 29 },
    ],
    [
      'left',
      { relativeX: -29, relativeY: -10, width: 24, height: 70 },
      { x: -29, y: 0, width: 29, height: 50 },
    ],
  ])('clips a side-separated caption %s to its body-face overlap', (_, textPlacement, expected) => {
    expect(touchExternalTextRangeToEntityClippedToBodyFace({ ...entity, textPlacement })).toEqual(
      expected,
    );
  });

  it.each([
    [
      'above',
      { relativeX: 10, relativeY: -29, width: 20, height: 24 },
      { x: 10, y: -29, width: 20, height: 29 },
    ],
    [
      'right',
      { relativeX: 55, relativeY: 10, width: 24, height: 20 },
      { x: 50, y: 10, width: 29, height: 20 },
    ],
    [
      'below',
      { relativeX: 10, relativeY: 55, width: 20, height: 24 },
      { x: 10, y: 50, width: 20, height: 29 },
    ],
    [
      'left',
      { relativeX: -29, relativeY: 10, width: 24, height: 20 },
      { x: -29, y: 10, width: 29, height: 20 },
    ],
  ])(
    'keeps only the caption/body face overlap when a separated caption is narrower %s',
    (_, textPlacement, expected) => {
      expect(touchExternalTextRangeToEntityClippedToBodyFace({ ...entity, textPlacement })).toEqual(
        expected,
      );
    },
  );

  it('keeps the full blocker for an ambiguous overlapping placement', () => {
    const overlapping = {
      ...entity,
      textPlacement: { relativeX: -10, relativeY: 10, width: 30, height: 20 },
    };
    expect(touchExternalTextRangeToEntityClippedToBodyFace(overlapping)).toEqual(
      touchExternalTextRangeToEntity(overlapping),
    );
  });

  it('keeps the full blocker when a separated caption only touches a body corner', () => {
    const cornerTouching = {
      ...entity,
      textPlacement: { relativeX: 50, relativeY: 55, width: 20, height: 24 },
    };
    expect(touchExternalTextRangeToEntityClippedToBodyFace(cornerTouching)).toEqual(
      touchExternalTextRangeToEntity(cornerTouching),
    );
  });
});

function makeShortRouteScenario(): {
  layoutManager: LayoutManager;
  connection: LayoutConnection;
  rawPastedConnection: {
    tag: string;
    id: string;
    from: string;
    to: string;
    label: string;
    x: number;
    y: number;
    points: [number, number][];
  };
} {
  const client = makeEntity(
    'client',
    { x: 40, y: 2405.1947723388676 },
    { width: 220, height: 200, isContainer: true },
  );
  const source = makeEntity(
    'source',
    { x: 90, y: 2486.5947723388676 },
    { width: 50, height: 50, containerId: 'client' },
  );
  const target = makeEntity(
    'target',
    { x: 170, y: 2486.5947723388676 },
    { width: 50, height: 50, containerId: 'client' },
  );

  const rawPastedConnection = {
    tag: 'Relationship',
    id: 'connection',
    from: 'source',
    to: 'target',
    label: 'label',
    x: SHORT_ROUTE_LINE.x,
    y: SHORT_ROUTE_LINE.y,
    points: [
      [0, 0],
      [SHORT_ROUTE_LINE.length, 0],
    ] as [number, number][],
  };

  const connection: LayoutConnection = {
    id: rawPastedConnection.id,
    from: rawPastedConnection.from,
    to: rawPastedConnection.to,
    x: rawPastedConnection.x,
    y: rawPastedConnection.y,
    points: rawPastedConnection.points,
    textPlacement: {
      // Simulates the measured-label fallback for stripped pasted JSON:
      // no persisted labelPlacement is allowed to influence placement.
      x: 0,
      y: 0,
      width: SHORT_ROUTE_LABEL.width,
      height: SHORT_ROUTE_LABEL.height,
    },
  };

  return {
    layoutManager: new LayoutManager({
      entities: [client, source, target],
      connections: [connection],
    }),
    connection,
    rawPastedConnection,
  };
}

function expectShortRoutePlacement(result: NonNullable<LayoutConnection['textPlacement']>): void {
  expect(result).toEqual(SHORT_ROUTE_EXPECTED.textPlacement);

  const labelCenterX = result.x + result.width / 2;
  const labelCenterY = result.y + result.height / 2;
  expect({ x: labelCenterX, y: labelCenterY }).toEqual(SHORT_ROUTE_EXPECTED.labelCenter);

  const labelPlacement = {
    x: result.x - SHORT_ROUTE_LINE.x,
    y: result.y - SHORT_ROUTE_LINE.y,
  };
  expect(labelPlacement).toEqual(SHORT_ROUTE_EXPECTED.labelPlacement);
  expect(labelPlacement).not.toEqual({ x: -125, y: -2495 });
}

describe('isLabelRectOnSegment', () => {
  const horizontalPoints: [number, number][] = [
    [0, 25],
    [60, 25],
    [60, 55],
  ];

  it('returns true when a wide label sits above a horizontal segment', () => {
    // Bottom of label near y=25 with gap; center is above the line.
    expect(isLabelRectOnSegment({ x: 0, y: 7, width: 60, height: 14 }, horizontalPoints, 0)).toBe(
      true,
    );
  });

  it('returns false when the label center is far from the segment', () => {
    expect(isLabelRectOnSegment({ x: 0, y: -40, width: 60, height: 14 }, horizontalPoints, 0)).toBe(
      false,
    );
  });

  it('returns false when the label is near the line but on a different segment index', () => {
    expect(isLabelRectOnSegment({ x: 53, y: 40, width: 14, height: 14 }, horizontalPoints, 0)).toBe(
      false,
    );
    expect(isLabelRectOnSegment({ x: 53, y: 40, width: 14, height: 14 }, horizontalPoints, 1)).toBe(
      true,
    );
  });

  it('returns true when a tall label sits beside a vertical segment', () => {
    const verticalPoints: [number, number][] = [
      [60, 0],
      [60, 40],
    ];
    // Label to the right of x=60; center near y=20.
    expect(isLabelRectOnSegment({ x: 64, y: 3, width: 60, height: 34 }, verticalPoints, 0)).toBe(
      true,
    );
  });
});

describe('adjustLabelPositionOffSegment', () => {
  it('moves wide labels above a horizontal segment instead of covering it', () => {
    const segment: CoordinateSegment = [
      { x: 140, y: 2511.4 },
      { x: 170, y: 2511.4 },
    ];

    expect(
      adjustLabelPositionOffSegment({ x: 125, y: 2504.4, width: 60, height: 14 }, segment),
    ).toEqual({ x: 125, y: 2493.4, width: 60, height: 14 });
  });

  it('keeps labels centered on the segment when they fit horizontally', () => {
    const segment: CoordinateSegment = [
      { x: 0, y: 10 },
      { x: 100, y: 10 },
    ];
    const centered = { x: 25, y: 3, width: 50, height: 14 };

    expect(adjustLabelPositionOffSegment(centered, segment)).toEqual(centered);
  });

  it('moves labels above when the segment is only slightly longer than the text', () => {
    const segmentLength = 50 + LABEL_OFF_SEGMENT_BUFFER - 1;
    const segment: CoordinateSegment = [
      { x: 0, y: 10 },
      { x: segmentLength, y: 10 },
    ];
    const label = { x: 0, y: 3, width: 50, height: 14 };

    expect(adjustLabelPositionOffSegment(label, segment)).toEqual({
      x: segmentLength / 2 - 25,
      y: 10 - 14 - LABEL_LINE_GAP,
      width: 50,
      height: 14,
    });
  });

  it('moves tall labels beside a vertical segment instead of covering it', () => {
    const segment: CoordinateSegment = [
      { x: 100, y: 200 },
      { x: 100, y: 230 },
    ];

    expect(
      adjustLabelPositionOffSegment({ x: 70, y: 208, width: 60, height: 34 }, segment),
    ).toEqual({ x: 104, y: 198, width: 60, height: 34 });
  });

  it('keeps labels centered on the segment when they fit vertically', () => {
    const segment: CoordinateSegment = [
      { x: 10, y: 0 },
      { x: 10, y: 100 },
    ];
    const centered = { x: -15, y: 43, width: 50, height: 14 };

    expect(adjustLabelPositionOffSegment(centered, segment)).toEqual(centered);
  });

  it('moves labels beside when the segment is only slightly longer than the text', () => {
    const segmentLength = 50 + LABEL_OFF_SEGMENT_BUFFER - 1;
    const segment: CoordinateSegment = [
      { x: 10, y: 0 },
      { x: 10, y: segmentLength },
    ];
    const label = { x: -20, y: 18, width: 60, height: 50 };

    expect(adjustLabelPositionOffSegment(label, segment)).toEqual({
      x: 14,
      y: segmentLength / 2 - 25,
      width: 60,
      height: 50,
    });
  });
});

describe('adjustLabelPositionOffSegment — manual lineOffset', () => {
  const verticalSegment: CoordinateSegment = [
    { x: 100, y: 200 },
    { x: 100, y: 230 },
  ];

  it('clears a wide label fully to the right of a vertical segment (counts label width)', () => {
    // half-width 30 exceeds the nominal 24px offset, so a center-only offset would straddle the line.
    const result = adjustLabelPositionOffSegment(
      { x: 0, y: 208, width: 60, height: 14 },
      verticalSegment,
      LABEL_LINE_GAP,
      24,
    );

    expect(result.x).toBeGreaterThan(100);
    expect(result.x).toBe(104); // lineX + (width/2 + gap) - width/2 = 100 + 34 - 30
    expect(result.y).toBe(208); // along-axis position preserved
  });

  it('mirrors the clearance to the left for a negative offset on a vertical segment', () => {
    const result = adjustLabelPositionOffSegment(
      { x: 0, y: 208, width: 60, height: 14 },
      verticalSegment,
      LABEL_LINE_GAP,
      -24,
    );

    expect(result.x + result.width).toBeLessThan(100);
    expect(result.x).toBe(36); // lineX - (width/2 + gap) - width/2 = 100 - 34 - 30
  });

  it('keeps the nominal offset on a horizontal segment when the label already clears it', () => {
    const horizontalSegment: CoordinateSegment = [
      { x: 140, y: 2511.4 },
      { x: 170, y: 2511.4 },
    ];

    const result = adjustLabelPositionOffSegment(
      { x: 125, y: 0, width: 60, height: 14 },
      horizontalSegment,
      LABEL_LINE_GAP,
      24,
    );

    // half-height 7 < 24, so the nominal offset wins: center sits exactly 24px above the line.
    expect(result.y).toBe(2511.4 - 24 - 7);
    expect(result.x).toBe(125);
  });
});

describe('resolveConnectionLabelRelativePlacement', () => {
  it('places tall labels beside short vertical segments', () => {
    const points: [number, number][] = [
      [0, 0],
      [0, 30],
    ];

    const placed = resolveConnectionLabelRelativePlacement(points, { width: 60, height: 50 });

    expect(placed.x).toBe(LABEL_LINE_GAP);
    expect(placed.y + placed.height / 2).toBeCloseTo(15, 0);
  });

  it('keeps wide but short labels centered on long enough vertical segments', () => {
    const points: [number, number][] = [
      [0, 0],
      [0, 80],
    ];

    const placed = resolveConnectionLabelRelativePlacement(points, { width: 200, height: 14 });

    expect(placed.x + placed.width / 2).toBeCloseTo(0, 0);
    expect(placed.y + placed.height / 2).toBeCloseTo(40, 0);
  });

  it('prefers a segment the label center is directly on over an earlier nearby elbow stub', () => {
    const points: [number, number][] = [
      [0, 0],
      [0, 30],
      [100, 30],
    ];
    const storedRelative = { x: 0, y: 23 };

    const placed = resolveConnectionLabelRelativePlacement(
      points,
      { width: 60, height: 14 },
      storedRelative,
    );

    expect(placed).toEqual({ ...storedRelative, width: 60, height: 14 });
  });
});

describe('placeTextElement', () => {
  it('does not treat measure-only textPlacement coords as a stored label offset', () => {
    const left = makeEntity('left', { x: 0, y: 0 }, { width: 50, height: 50 });
    const right = makeEntity('right', { x: 80, y: 0 }, { width: 50, height: 50 });

    const connection: LayoutConnection = {
      id: 'conn',
      from: 'left',
      to: 'right',
      x: 0,
      y: 0,
      points: [
        [0, 0],
        [80, 0],
      ],
      textPlacement: { x: Number.NaN, y: Number.NaN, width: 60, height: 14 },
    };

    const layoutManager = new LayoutManager({
      entities: [left, right],
      connections: [connection],
    });

    const result = placeTextElement(
      layoutManager,
      connection,
      layoutManager.getTextPlacements(),
      'y',
    );

    expect(result).toBeDefined();
    expect(result!.x + result!.width / 2).toBeCloseTo(40, 0);
    // 60px text + 25px buffer exceeds the 80px segment — label sits above the line.
    expect(result!.y + result!.height / 2).toBeCloseTo(-11, 0);
  });

  it('falls back to the center of the center-most primary segment when no segment is long enough for the text', () => {
    const left = makeEntity('left', { x: 0, y: 0 }, { width: 50, height: 50 });
    const right = makeEntity('right', { x: 80, y: 0 }, { width: 50, height: 50 });

    // Single short horizontal segment from (50, 25) to (80, 25): only 30 units long.
    // The text we want to place is 60 wide, so no segment passes the length filter.
    const connection: LayoutConnection = {
      id: 'conn',
      from: 'left',
      to: 'right',
      x: 50,
      y: 25,
      points: [
        [0, 0],
        [30, 0],
      ],
      // Stale absolute placement from a previous route, way off the line.
      textPlacement: { x: -500, y: -500, width: 60, height: 14 },
    };

    const layoutManager = new LayoutManager({
      entities: [left, right],
      connections: [connection],
    });

    const result = placeTextElement(
      layoutManager,
      connection,
      layoutManager.getTextPlacements(),
      'y',
    );

    expect(result).toBeDefined();
    // Label is wider than the 30-unit segment, so it sits above the horizontal line at y=25:
    //   x = 65 - 60/2 = 35
    //   y = 25 - 14 - 4 = 7
    expect(result).toEqual({ x: 35, y: 7, width: 60, height: 14 });
  });

  it('places tall labels beside short vertical segments', () => {
    const top = makeEntity('top', { x: 0, y: 0 }, { width: 50, height: 50 });
    const bottom = makeEntity('bottom', { x: 0, y: 80 }, { width: 50, height: 50 });

    const connection: LayoutConnection = {
      id: 'conn',
      from: 'top',
      to: 'bottom',
      x: 25,
      y: 50,
      points: [
        [0, 0],
        [0, 30],
      ],
      textPlacement: { x: Number.NaN, y: Number.NaN, width: 60, height: 50 },
    };

    const layoutManager = new LayoutManager({
      entities: [top, bottom],
      connections: [connection],
    });

    const result = placeTextElement(
      layoutManager,
      connection,
      layoutManager.getTextPlacements(),
      'x',
    );

    expect(result).toBeDefined();
    // 50px text + 25px buffer exceeds the 30-unit segment — label sits beside the line at x=25.
    expect(result!.x).toBe(25 + LABEL_LINE_GAP);
    expect(result!.y + result!.height / 2).toBeCloseTo(65, 0);
  });

  it('places stripped text near a route whose terminal stub is too short', () => {
    // The measured label is wider than the terminal segment, so placement must use nearby space.
    const { layoutManager, connection, rawPastedConnection } = makeShortRouteScenario();

    expect(rawPastedConnection).not.toHaveProperty('labelPlacement');

    const result = placeTextElement(
      layoutManager,
      connection,
      layoutManager.getTextPlacements(),
      'y',
    );

    expect(result).toBeDefined();
    expectShortRoutePlacement(result!);

    const before = layoutManager.getConnectionById('connection')!;
    expect(before.textPlacement).toEqual({
      x: 0,
      y: 0,
      width: SHORT_ROUTE_LABEL.width,
      height: SHORT_ROUTE_LABEL.height,
    });

    const route: RoutedConnectionChange = {
      x: SHORT_ROUTE_LINE.x,
      y: SHORT_ROUTE_LINE.y,
      points: [
        [0, 0],
        [SHORT_ROUTE_LINE.length, 0],
      ],
    };

    finalizeShiftRoute(layoutManager, connection, route);

    const after = layoutManager.getConnectionById('connection')!;
    expectShortRoutePlacement(after.textPlacement!);
  });

  it('auto-places explicit stored text placement during routing', () => {
    const { layoutManager, connection } = makeShortRouteScenario();
    const explicitPlacement = {
      x: 0,
      y: 0,
      width: SHORT_ROUTE_LABEL.width,
      height: SHORT_ROUTE_LABEL.height,
    };

    layoutManager.updateConnection(connection.id, {
      textPlacement: explicitPlacement,
      textPlacementSource: LayoutConnectionTextPlacementSource.STORED,
    });

    const storedConnection = layoutManager.getConnectionById('connection')!;
    const route: RoutedConnectionChange = {
      x: SHORT_ROUTE_LINE.x,
      y: SHORT_ROUTE_LINE.y,
      points: [
        [0, 0],
        [SHORT_ROUTE_LINE.length, 0],
      ],
    };

    finalizeShiftRoute(layoutManager, storedConnection, route);

    const after = layoutManager.getConnectionById('connection')!;
    expectShortRoutePlacement(after.textPlacement!);
  });

  it('auto-places stored text placement when rerouting from an unstaged connection', () => {
    const left = makeEntity('left', { x: 0, y: 0 }, { width: 50, height: 50 });
    const right = makeEntity('right', { x: 200, y: 0 }, { width: 50, height: 50 });
    const connection: LayoutConnection = {
      id: 'conn',
      from: 'left',
      to: 'right',
      x: 100,
      y: 100,
      points: [
        [0, 0],
        [40, 0],
      ],
      textPlacement: { x: 110, y: 105, width: 60, height: 14 },
      textPlacementSource: LayoutConnectionTextPlacementSource.STORED,
    };

    const layoutManager = new LayoutManager({
      entities: [left, right],
      connections: [connection],
    });
    const route: RoutedConnectionChange = {
      x: 120,
      y: 130,
      points: [
        [0, 0],
        [40, 0],
      ],
    };

    finalizeShiftRoute(layoutManager, connection, route);

    const doubleShiftedPlacement = { x: 130, y: 135, width: 60, height: 14 };
    const expectedPlacement = { x: 110, y: 112, width: 60, height: 14 };
    const after = layoutManager.getConnectionById('conn')!;
    expect(after.textPlacement).toEqual(expectedPlacement);
    expect(after.textPlacement).not.toEqual(doubleShiftedPlacement);
  });
});
