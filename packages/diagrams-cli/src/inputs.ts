import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { OutputFormat } from './config.js';

export const STDIN = '-';

export type InputRead =
  { ok: true; document: unknown; unwrapped: boolean } | { ok: false; message: string };

/**
 * Every accepted document form — `{ title, elements }`, `{ entities, connections }` — goes through
 * untouched; the engine owns the input grammar, and a bare array is its `E_ENVELOPE` error rather
 * than something this layer wraps. The one shape that is not a document is the app's
 * `{ definition: { elements } }` export wrapper, which is lifted so exported diagrams can be
 * passed in verbatim.
 */
export function unwrapDocument(raw: unknown): { document: unknown; unwrapped: boolean } {
  if (Array.isArray(raw) || typeof raw !== 'object' || raw === null) {
    return { document: raw, unwrapped: false };
  }

  const wrapped = raw as { definition?: { elements?: unknown } };

  if (Array.isArray(wrapped.definition?.elements)) {
    return { document: { elements: wrapped.definition.elements }, unwrapped: true };
  }

  return { document: raw, unwrapped: false };
}

export function readInput(
  spec: string,
  readStdin: () => string = () => readFileSync(0, 'utf8'),
): InputRead {
  let text: string;

  try {
    text = spec === STDIN ? readStdin() : readFileSync(spec, 'utf8');
  } catch (error) {
    return { ok: false, message: `Cannot read ${spec}: ${(error as Error).message}` };
  }

  try {
    return { ok: true, ...unwrapDocument(JSON.parse(text)) };
  } catch (error) {
    return { ok: false, message: `Invalid JSON in ${spec}: ${(error as Error).message}` };
  }
}

/** `diagram.<format>` for stdin; otherwise the input's basename with the extension swapped. */
export function outputName(spec: string, format: OutputFormat): string {
  if (spec === STDIN) {
    return `diagram.${format}`;
  }

  return `${basename(spec, extname(spec))}.${format}`;
}
