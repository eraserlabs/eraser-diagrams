/**
 * True-boundary descriptors per shape kind, in the 0–100 frame (`OutlineDescriptor` in
 * `@eraserlabs/layout`). Straight-edged kinds reuse POLYGON_VERTICES with corner radii; CSS-geometry
 * kinds mirror their border-radius rules; cylinder/document flatten curves into short chords.
 */

import type { OutlineDescriptor, OutlineVertex } from '@eraserlabs/layout';
import { CORNER_RADIUS } from './roundedPolygon.js';
import { POLYGON_VERTICES } from './shapeVertices.js';

const RECTANGLE_VERTICES: readonly OutlineVertex[] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];

/** Chords per curve — at typical node sizes the largest deviation stays under half a pixel. */
const CAP_SEGMENTS = 12;
const CURVE_SEGMENTS = 6;
const CORNER_SEGMENTS = 3;

/** Cylinder caps are 11%-height half-ellipses (Shape.html `A 50,11` arcs). */
const CYLINDER_CAP_RY = 11;

function cylinderVertices(): OutlineVertex[] {
  const vertices: OutlineVertex[] = [];

  for (let i = 0; i <= CAP_SEGMENTS; i += 1) {
    const theta = Math.PI - (Math.PI * i) / CAP_SEGMENTS;
    vertices.push([50 + 50 * Math.cos(theta), CYLINDER_CAP_RY - CYLINDER_CAP_RY * Math.sin(theta)]);
  }

  for (let i = 0; i <= CAP_SEGMENTS; i += 1) {
    const theta = (Math.PI * i) / CAP_SEGMENTS;
    vertices.push([
      50 + 50 * Math.cos(theta),
      100 - CYLINDER_CAP_RY + CYLINDER_CAP_RY * Math.sin(theta),
    ]);
  }

  return vertices;
}

type DocumentCurve = {
  control1: OutlineVertex;
  control2: OutlineVertex;
  to: OutlineVertex;
  segments: number;
};
type DocumentStep = DocumentCurve | { line: OutlineVertex };

/** The document path's anchors and cubics, transcribed from Shape.html. */
const DOCUMENT_START: OutlineVertex = [0.87, 6.67];
const DOCUMENT_STEPS: ReadonlyArray<DocumentStep> = [
  { control1: [0.87, 3.47], control2: [3.41, 1], to: [6.53, 1], segments: CORNER_SEGMENTS },
  { line: [93.3, 1] },
  { control1: [96.4, 1], control2: [99, 3.51], to: [99, 7], segments: CORNER_SEGMENTS },
  { line: [99, 77.7] },
  { control1: [98.9, 86.3], control2: [95.1, 89.9], to: [91.3, 88.8], segments: CURVE_SEGMENTS },
  { control1: [85.1, 87.1], control2: [76.1, 85.1], to: [68.5, 85.1], segments: CURVE_SEGMENTS },
  { control1: [55.4, 98.1], control2: [44.3, 98.1], to: [28, 98.1], segments: CURVE_SEGMENTS },
  { control1: [15.2, 98.1], control2: [5.9, 90.8], to: [2.45, 87.6], segments: CURVE_SEGMENTS },
  { control1: [0.87, 86.7], control2: [0.87, 85.2], to: [0.87, 83.9], segments: CORNER_SEGMENTS },
];

function cubicPoint(from: OutlineVertex, curve: DocumentCurve, t: number): OutlineVertex {
  const inverse = 1 - t;
  const weightFrom = inverse * inverse * inverse;
  const weightControl1 = 3 * inverse * inverse * t;
  const weightControl2 = 3 * inverse * t * t;
  const weightTo = t * t * t;

  return [
    weightFrom * from[0] +
      weightControl1 * curve.control1[0] +
      weightControl2 * curve.control2[0] +
      weightTo * curve.to[0],
    weightFrom * from[1] +
      weightControl1 * curve.control1[1] +
      weightControl2 * curve.control2[1] +
      weightTo * curve.to[1],
  ];
}

function documentVertices(): OutlineVertex[] {
  const vertices: OutlineVertex[] = [DOCUMENT_START];
  let from = DOCUMENT_START;

  for (const step of DOCUMENT_STEPS) {
    if ('line' in step) {
      vertices.push(step.line);
      from = step.line;
      continue;
    }

    for (let i = 1; i <= step.segments; i += 1) {
      vertices.push(cubicPoint(from, step, i / step.segments));
    }

    from = step.to;
  }

  return vertices;
}

const SAMPLED_OUTLINES: Record<string, OutlineDescriptor> = {
  cylinder: { kind: 'polygon', vertices: cylinderVertices() },
  document: { kind: 'polygon', vertices: documentVertices() },
};

/** The drawn boundary for a shape kind, or null when the bounding box already is the boundary. */
export function shapeOutline(kind: string): OutlineDescriptor | null {
  const polygonVertices = POLYGON_VERTICES[kind];

  if (polygonVertices) {
    return { kind: 'polygon', vertices: polygonVertices, cornerRadius: CORNER_RADIUS[kind] ?? 0 };
  }

  if (kind === 'rectangle') {
    // Shape.style.css `border-radius: min(12px, 15%)`; the 15% resolves per axis in CSS, so a
    // very flat box paints slightly elliptical corners this circular radius only approximates.
    return {
      kind: 'polygon',
      vertices: RECTANGLE_VERTICES,
      cornerRadius: 12,
      cornerRadiusPercent: 15,
    };
  }

  if (kind === 'oval') {
    return { kind: 'polygon', vertices: RECTANGLE_VERTICES, cornerRadiusPercent: 50 };
  }

  if (kind === 'circle' || kind === 'ellipse') {
    return { kind: 'ellipse' };
  }

  return SAMPLED_OUTLINES[kind] ?? null;
}
