#!/usr/bin/env node
// Strips comments from every .js under ./dist (run from a package root, after tsc emit).
// tsc's own removeComments also strips JSDoc from .d.ts — which editors need — so the split
// is: declarations keep their docs, shipped JS goes comment-free via an esbuild reprint
// (no minification; the code stays readable, shebangs survive).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'esbuild';

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return walk(path);
    }

    return entry.name.endsWith('.js') && !entry.name.endsWith('.iife.js')
      ? [path]
      : [];
  });
}

for (const file of walk('dist')) {
  // target esnext: a pure reprint. Anything lower makes esbuild "lower" newer syntax — it
  // DROPPED `with { type: 'json' }` import attributes at es2023, breaking Node's JSON imports.
  const { code } = transformSync(readFileSync(file, 'utf8'), {
    loader: 'js',
    format: 'esm',
    target: 'esnext',
    legalComments: 'none',
  });
  writeFileSync(file, code);
}
