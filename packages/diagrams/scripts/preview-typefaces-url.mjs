import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createRenderer } from '../dist/index.js';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const fontsDir = join(repo, 'packages/diagrams/fonts');
const doc = JSON.parse(
  await readFile(join(repo, 'fixtures/features/typefaces.json'), 'utf8'),
);

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-private-network': 'true',
};

const server = createServer((req, res) => {
  const path = req.url ?? '/';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  readFile(join(fontsDir, basename(path))).then(
    (bytes) => {
      res.writeHead(200, { 'content-type': 'font/woff2', ...cors });
      res.end(bytes);
    },
    () => {
      res.writeHead(404, cors);
      res.end();
    },
  );
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const url = (file) => `http://127.0.0.1:${port}/${file}`;

const renderer = await createRenderer({
  chromiumPath: chromium.executablePath(),
  iconLoader: async () => {
    throw new Error('no icons in this preview');
  },
  fonts: {
    roles: { rough: 'ShantellSans', clean: 'Inter', mono: 'JetBrainsMono' },
    throwOnFontFail: true,
    fallbacks: { rough: 'sans-serif', clean: 'sans-serif', mono: 'monospace' },
    faces: [
      {
        kind: 'url',
        family: 'ShantellSans',
        url: url('ShantellSans.var.woff2'),
        format: 'woff2',
        weight: '300 800',
      },
      {
        kind: 'url',
        family: 'Inter',
        url: url('Inter.var.woff2'),
        format: 'woff2',
        weight: '100 900',
      },
      {
        kind: 'url',
        family: 'JetBrainsMono',
        url: url('JetBrainsMono-Regular.woff2'),
        format: 'woff2',
      },
    ],
  },
});

const outcome = await renderer.render({
  ...doc,
  outputs: { png: true, html: true },
});

await renderer.close();
await new Promise((resolve, reject) =>
  server.close((e) => (e ? reject(e) : resolve())),
);

if (!outcome.ok) {
  console.error(JSON.stringify(outcome.errors, null, 2));
  process.exit(1);
}

const pngPath = '/tmp/typefaces-url.png';
const htmlPath = '/tmp/typefaces-url.html';
await writeFile(pngPath, outcome.png);
await writeFile(htmlPath, outcome.html);
console.log(pngPath);
console.log(htmlPath);
console.log(
  outcome.html.includes("src:url('http://127.0.0.1")
    ? 'html-has-url-faces'
    : 'html-missing-url',
);
console.log(
  outcome.html.includes('base64') ? 'html-has-base64' : 'html-no-base64',
);
