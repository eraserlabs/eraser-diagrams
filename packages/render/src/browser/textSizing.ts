import { TEXT_SIZE_POLICIES, type TextSizePolicy } from '@eraserlabs/protocol';
import type { ResolvedConnection, ResolvedEntity } from '@eraserlabs/protocol';
import type { Box, SceneLayout } from '@eraserlabs/render';
import { isRecord } from '@eraserlabs/utils';
import type { MeasuredBox } from './measure.js';
import type { MountedElement } from './mount.js';

const POLICY_ATTRIBUTE = 'data-text-grow-policy';
const MAX_LINES_ATTRIBUTE = 'data-text-max-lines';
const ASPECT_ATTRIBUTE = 'data-text-aspect';
const DEFAULT_MAX_LINES = 3;
const DEFAULT_ASPECT = 0.8;
const MAIN_APP_ASPECT_MAGIC = 1.2;
// Renderer policy, deliberately not part of the MDP wire contract. It is the preferred wrapping
// width when neither the author nor a route supplies one; balanced text may still grow past it.
const DEFAULT_UNAUTHORED_TEXT_WIDTH = 100;
const EPSILON = 0.5;
const MAX_GROWTH_PASSES = 6;
const CONNECTION_LABEL_END_MARGIN = 24;
const CONNECTION_LABEL_MIN_WIDTH = 48;
// Authored widths and persisted label caps were measured in the authoring app's typeface; ours is
// not metric-compatible, so a box a few percent too narrow states a mismatch, not an intent to
// hyphenate. Widen to keep words whole up to this factor of the preferred width — past it the
// longest word is genuinely oversized for the box and character breaking is the right answer.
const WORD_FIT_TOLERANCE = 1.5;

interface TextPolicyNode {
  node: HTMLElement;
  policy: TextSizePolicy;
  maxLines: number;
  aspect: number;
  naturalTextWidth: number;
  lineHeight: number;
}

interface Overflow {
  left: number;
  top: number;
  right: number;
  bottom: number;
  scrollHeight: number;
}

/**
 * Resolve entity dimensions around semantic internal-text boxes. Templates opt individual text
 * boxes into a policy with `data-text-grow-policy`; an unannotated internal-text box defaults to
 * balanced. Templates without internal text retain the ordinary max(authored, intrinsic) rule.
 */
export function resolveTextSizedElements(
  entities: ResolvedEntity[],
  mounted: MountedElement[],
  intrinsics: Map<string, MeasuredBox>,
): Map<string, MeasuredBox> {
  const elementById = new Map(entities.map((element) => [element.id, element]));
  const resolved = new Map<string, MeasuredBox>();

  for (const mountedElement of mounted) {
    const element = elementById.get(mountedElement.id);

    if (!element) {
      continue;
    }

    const { wrapper } = mountedElement;
    const intrinsic = intrinsics.get(element.id) ?? rect(0, 0);
    const policies = internalPolicies(wrapper);
    let width: number;
    let height: number;

    if (policies.length === 0 || policies.every(({ policy }) => policy === 'width-only')) {
      width = Math.max(element.width ?? 0, intrinsic.width);
      height = Math.max(element.height ?? 0, intrinsic.height);
    } else {
      const templateFloor = templateWidthFloor(wrapper);
      width =
        element.width ??
        Math.min(intrinsic.width, Math.max(DEFAULT_UNAUTHORED_TEXT_WIDTH, templateFloor));
      height = Math.max(element.height ?? 0, intrinsic.height, naturalContentHeight(wrapper));
      setWrapperSize(wrapper, width, height);
      width = Math.max(width, wordIntegrityWidth(policies, width));
      setWrapperSize(wrapper, width, height);

      if (policies.some(({ policy }) => policy === 'balanced')) {
        // The balanced target is anchored on the currently rendered text width, which lags the
        // wrapper width through percentage insets and wrap granularity — applied once it leaves
        // the target unmet AND non-idempotent: re-entering the produced width as authored moves
        // it again (the echo drift pinned by echo-idempotence.spec). Iterate to the fixed point;
        // the step is monotone non-decreasing and bounded by max-content, and the residual
        // contracts by the inset fraction per pass, so it lands within EPSILON in a few passes.
        for (let pass = 0; pass < MAX_GROWTH_PASSES; pass += 1) {
          const next = balancedWidth(wrapper, policies, width, intrinsic.width);

          if (next - width <= EPSILON) {
            break;
          }

          width = next;
          setWrapperSize(wrapper, width, height);
        }

        width = growForHorizontalOverflow(wrapper, width, height);
        setWrapperSize(wrapper, width, height);
      }

      height = growForVerticalOverflow(wrapper, width, height);
    }

    setWrapperSize(wrapper, width, height);
    resolved.set(element.id, rect(width, height));
  }

  return resolved;
}

/**
 * Once a route exists, constrain opted-in connection labels to its longest horizontal straight
 * run (or a persisted label width). A changed box asks the caller to remeasure and route again.
 */
export function constrainConnectionLabels(
  connections: ResolvedConnection[],
  mounted: MountedElement[],
  layout: SceneLayout,
): boolean {
  const elementById = new Map(connections.map((element) => [element.id, element]));
  let changed = false;

  for (const { id, wrapper } of mounted) {
    const element = elementById.get(id);
    const geometry = layout.connections[id];

    if (!element || !geometry) {
      continue;
    }

    const cap = connectionLabelWidth(element, geometry.points);

    if (cap === undefined) {
      continue;
    }

    for (const node of ownRoleNodes(wrapper, 'external-text')) {
      const policy = parsePolicy(node.getAttribute(POLICY_ATTRIBUTE), 'balanced');

      if (policy === 'width-only') {
        continue;
      }

      const naturalWidth = externalNaturalWidths.get(node) ?? node.getBoundingClientRect().width;
      externalNaturalWidths.set(node, naturalWidth);
      const capped = Math.min(naturalWidth, cap);
      const minimum = minContentWidth(node);
      const nextWidth = minimum <= capped * WORD_FIT_TOLERANCE ? Math.max(minimum, capped) : capped;
      const currentWidth = Number.parseFloat(node.style.width);

      if (Number.isFinite(currentWidth) && Math.abs(currentWidth - nextWidth) <= EPSILON) {
        continue;
      }

      node.style.width = `${nextWidth}px`;
      changed = true;
    }
  }

  return changed;
}

/**
 * Balanced/height-only connection labels need a path before they have a width. Omit their natural
 * max-content boxes from the provisional route so that the route cannot manufacture a longer
 * segment merely to accommodate the width from which its cap will then be derived.
 */
export function deferConstrainedConnectionLabels(
  connections: ResolvedConnection[],
  mounted: MountedElement[],
  externalText: Map<string, Box[]>,
): { externalText: Map<string, Box[]>; deferred: boolean } {
  const elementById = new Map(connections.map((element) => [element.id, element]));
  const provisional = new Map(externalText);
  let deferred = false;

  for (const { id, wrapper } of mounted) {
    const element = elementById.get(id);

    if (!element) {
      continue;
    }

    const constrained = ownRoleNodes(wrapper, 'external-text').some(
      (node) => parsePolicy(node.getAttribute(POLICY_ATTRIBUTE), 'balanced') !== 'width-only',
    );

    if (constrained) {
      provisional.delete(id);
      deferred = true;
    }
  }

  return { externalText: provisional, deferred };
}

const externalNaturalWidths = new WeakMap<HTMLElement, number>();

/**
 * Preserve a concrete width imposed by template CSS. Measuring the body against a zero-width host
 * distinguishes `width: 240px` / `min-width` from the ordinary `width: 100%` used by stock roots.
 */
function templateWidthFloor(wrapper: HTMLElement): number {
  const body = ownRoleNodes(wrapper, 'body')[0];

  if (!body) {
    return 0;
  }

  const previousWidth = wrapper.style.width;
  wrapper.style.width = '0px';
  const width = body.getBoundingClientRect().width;
  wrapper.style.width = previousWidth;

  return width;
}

/**
 * Width a wrapper needs so no word is chopped mid-way. The widest unbreakable run is the text
 * node's min-content width — `overflow-wrap: break-word` keeps that at whole words — plus the
 * horizontal inset the template puts between wrapper and text node. Only a shortfall inside
 * WORD_FIT_TOLERANCE is repaired; a token that overshoots by more is genuinely too big for its
 * box and still breaks.
 */
function wordIntegrityWidth(policies: TextPolicyNode[], width: number): number {
  let floor = 0;

  for (const spec of policies) {
    if (spec.policy === 'width-only') {
      continue;
    }

    const textWidth = spec.node.getBoundingClientRect().width;
    const minimum = minContentWidth(spec.node);

    if (minimum > textWidth * WORD_FIT_TOLERANCE) {
      continue;
    }

    floor = Math.max(floor, minimum + Math.max(0, width - textWidth));
  }

  return floor;
}

function minContentWidth(node: HTMLElement): number {
  const previous = node.style.width;
  node.style.width = 'min-content';
  const width = node.getBoundingClientRect().width;
  node.style.width = previous;

  return width;
}

function internalPolicies(wrapper: HTMLElement): TextPolicyNode[] {
  return ownRoleNodes(wrapper, 'internal-text').map((node) => {
    const rects = textRects(node);

    return {
      node,
      policy: parsePolicy(node.getAttribute(POLICY_ATTRIBUTE), 'balanced'),
      maxLines: positiveNumber(node.getAttribute(MAX_LINES_ATTRIBUTE)) ?? DEFAULT_MAX_LINES,
      aspect: positiveNumber(node.getAttribute(ASPECT_ATTRIBUTE)) ?? DEFAULT_ASPECT,
      naturalTextWidth: Math.max(node.scrollWidth, ...rects.map((textRect) => textRect.width)),
      lineHeight: Math.max(0, ...rects.map((textRect) => textRect.height)),
    };
  });
}

function parsePolicy(value: string | null, fallback: TextSizePolicy): TextSizePolicy {
  return TEXT_SIZE_POLICIES.includes(value as TextSizePolicy)
    ? (value as TextSizePolicy)
    : fallback;
}

function balancedWidth(
  wrapper: HTMLElement,
  policies: TextPolicyNode[],
  width: number,
  intrinsicWidth: number,
): number {
  let desired = width;

  for (const spec of policies) {
    if (spec.policy !== 'balanced' || maxLineCount(spec.node) <= spec.maxLines) {
      continue;
    }

    const currentTextWidth = spec.node.getBoundingClientRect().width;
    const targetTextWidth =
      Math.sqrt(spec.naturalTextWidth * spec.lineHeight) * spec.aspect * MAIN_APP_ASPECT_MAGIC;
    desired = Math.max(desired, width + Math.max(0, targetTextWidth - currentTextWidth));
  }

  // The balanced pass can reclaim some of max-content, never exceed it. Hard atomic overflow is
  // handled separately and may still require the natural width.
  return Math.max(width, Math.min(intrinsicWidth, desired));
}

function growForHorizontalOverflow(
  wrapper: HTMLElement,
  initialWidth: number,
  height: number,
): number {
  let width = initialWidth;

  for (let pass = 0; pass < MAX_GROWTH_PASSES; pass += 1) {
    setWrapperSize(wrapper, width, height);
    const overflow = internalOverflow(wrapper);
    const extra = overflow.left + overflow.right;

    if (extra <= EPSILON) {
      break;
    }

    width += extra;
  }

  return width;
}

function growForVerticalOverflow(
  wrapper: HTMLElement,
  width: number,
  initialHeight: number,
): number {
  let height = initialHeight;

  for (let pass = 0; pass < MAX_GROWTH_PASSES; pass += 1) {
    setWrapperSize(wrapper, width, height);
    const overflow = internalOverflow(wrapper);
    const extra = verticalOverflow(overflow);

    if (extra <= EPSILON) {
      break;
    }

    const candidate = height + extra;
    setWrapperSize(wrapper, width, candidate);

    // A template may deliberately give its text node a fixed height. Growing the wrapper cannot
    // repair that node's scroll overflow, so reject a trial that made no measurable progress.
    if (verticalOverflow(internalOverflow(wrapper)) >= extra - EPSILON) {
      setWrapperSize(wrapper, width, height);
      break;
    }

    height = candidate;
  }

  return height;
}

function verticalOverflow(overflow: Overflow): number {
  return overflow.top + overflow.bottom + overflow.scrollHeight;
}

function internalOverflow(wrapper: HTMLElement): Overflow {
  const body = ownRoleNodes(wrapper, 'body')[0] ?? wrapper;
  const bodyRect = body.getBoundingClientRect();
  let left = bodyRect.left;
  let top = bodyRect.top;
  let right = bodyRect.right;
  let bottom = bodyRect.bottom;

  for (const node of ownContentNodes(wrapper)) {
    const nodeRect = node.getBoundingClientRect();

    if (nodeRect.width === 0 && nodeRect.height === 0) {
      continue;
    }

    left = Math.min(left, nodeRect.left);
    top = Math.min(top, nodeRect.top);
    right = Math.max(right, nodeRect.right);
    bottom = Math.max(bottom, nodeRect.bottom);
  }

  const scrollHeight = Math.max(
    0,
    ...ownRoleNodes(wrapper, 'internal-text').map((node) => node.scrollHeight - node.clientHeight),
  );

  return {
    left: Math.max(0, bodyRect.left - left),
    top: Math.max(0, bodyRect.top - top),
    right: Math.max(0, right - bodyRect.right),
    bottom: Math.max(0, bottom - bodyRect.bottom),
    scrollHeight,
  };
}

function naturalContentHeight(wrapper: HTMLElement): number {
  const nodes = ownContentNodes(wrapper);

  if (nodes.length === 0) {
    return 0;
  }

  let top = Infinity;
  let bottom = -Infinity;

  for (const node of nodes) {
    const nodeRect = node.getBoundingClientRect();

    if (nodeRect.width === 0 && nodeRect.height === 0) {
      continue;
    }

    top = Math.min(top, nodeRect.top);
    bottom = Math.max(bottom, nodeRect.bottom);
  }

  return Number.isFinite(top) && Number.isFinite(bottom) ? bottom - top : 0;
}

function ownContentNodes(wrapper: HTMLElement): HTMLElement[] {
  return ownNodes(wrapper, '*').filter((node) => {
    // aria-hidden marks paint-only decoration (wash textures, geo strokes) — layers that
    // deliberately paint past the body box. They are ink, never content: counting their rects
    // here feeds the overflow-growth loop its own spill and the box inflates geometrically.
    const excluded = node.closest(
      '[data-role="external-text"],[data-role="badge"],[aria-hidden="true"]',
    );

    return excluded === null || excluded.closest('[data-mdp-tag]') !== wrapper;
  });
}

function ownRoleNodes(wrapper: HTMLElement, role: string): HTMLElement[] {
  return ownNodes(wrapper, `[data-role="${role}"]`);
}

function ownNodes(wrapper: HTMLElement, selector: string): HTMLElement[] {
  return [...wrapper.querySelectorAll<HTMLElement>(selector)].filter(
    (node) => node.closest('[data-mdp-tag]') === wrapper,
  );
}

function maxLineCount(node: HTMLElement): number {
  const groups = [...node.children].filter((child) => child.textContent?.trim());

  if (groups.length === 0) {
    return lineCount(node);
  }

  return Math.max(0, ...groups.map((group) => lineCount(group as HTMLElement)));
}

function lineCount(node: HTMLElement): number {
  const fragments = mergedLineCount(textRects(node));
  const computed = getComputedStyle(node);
  const parsedLineHeight = Number.parseFloat(computed.lineHeight);
  const parsedFontSize = Number.parseFloat(computed.fontSize);
  const lineHeight =
    Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
      ? parsedLineHeight
      : Number.isFinite(parsedFontSize) && parsedFontSize > 0
        ? parsedFontSize * 1.2
        : 0;
  const heightLines = lineHeight > 0 ? Math.ceil((node.scrollHeight - EPSILON) / lineHeight) : 0;

  return Math.max(fragments, heightLines);
}

function mergedLineCount(rects: DOMRect[]): number {
  const bands: { top: number; bottom: number }[] = [];

  for (const textRect of rects.sort(
    (left, right) => left.top - right.top || left.left - right.left,
  )) {
    const existing = bands.find(
      (band) => textRect.top < band.bottom - EPSILON && textRect.bottom > band.top + EPSILON,
    );

    if (existing) {
      existing.top = Math.min(existing.top, textRect.top);
      existing.bottom = Math.max(existing.bottom, textRect.bottom);
    } else {
      bands.push({ top: textRect.top, bottom: textRect.bottom });
    }
  }

  return bands.length;
}

function textRects(root: HTMLElement): DOMRect[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const rects: DOMRect[] = [];
  let current = walker.nextNode();

  while (current) {
    if (current.textContent?.trim()) {
      const range = document.createRange();
      range.selectNodeContents(current);
      rects.push(...range.getClientRects());
    }

    current = walker.nextNode();
  }

  return rects;
}

function connectionLabelWidth(
  element: ResolvedConnection,
  points: [number, number][],
): number | undefined {
  const stored = element.props['labelPlacement'];

  if (isRecord(stored) && positiveNumber(stored['width']) !== undefined) {
    return positiveNumber(stored['width']);
  }

  let longestHorizontalRun = 0;
  let runStart: [number, number] | undefined;
  let runEnd: [number, number] | undefined;

  for (let index = 0; index + 1 < points.length; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;

    if (from[1] === to[1]) {
      if (runEnd && runEnd[0] === from[0] && runEnd[1] === from[1]) {
        runEnd = to;
      } else {
        runStart = from;
        runEnd = to;
      }

      longestHorizontalRun = Math.max(longestHorizontalRun, Math.abs(runEnd[0] - runStart![0]));
    } else {
      runStart = undefined;
      runEnd = undefined;
    }
  }

  if (longestHorizontalRun <= 0) {
    return undefined;
  }

  return Math.max(CONNECTION_LABEL_MIN_WIDTH, longestHorizontalRun - CONNECTION_LABEL_END_MARGIN);
}

function setWrapperSize(wrapper: HTMLElement, width: number, height: number): void {
  wrapper.style.width = `${Math.max(0, width)}px`;
  wrapper.style.height = `${Math.max(0, height)}px`;
}

function rect(width: number, height: number): MeasuredBox {
  return { x: 0, y: 0, width, height };
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  return undefined;
}
