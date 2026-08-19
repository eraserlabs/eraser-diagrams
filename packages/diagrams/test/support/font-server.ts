import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { AddressInfo } from 'node:net';

export interface FontServer {
  /** Absolute URL for a fixture file. */
  url(file: string): string;
  /** Every request path served so far (cache-hit proofs count these). */
  requests: string[];
  /** When set, every response is this status with no body (degrade scenarios). */
  failWith: number | undefined;
  close(): Promise<void>;
}

/** Local HTTP server over the fixtures dir with a request ledger. Never touches the real web. */
export async function startFontServer(fixturesDir: string): Promise<FontServer> {
  const requests: string[] = [];

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-private-network': 'true',
  };

  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();

      return;
    }

    requests.push(path);

    if (out.failWith !== undefined) {
      res.writeHead(out.failWith, cors);
      res.end();

      return;
    }

    readFile(join(fixturesDir, basename(path))).then(
      (bytes) => {
        // @font-face fetches are CORS-mode; without ACAO the browser silently drops the font
        // (real font CDNs send this header too).
        const contentType = path.endsWith('.woff2') ? 'font/woff2' : 'font/ttf';
        res.writeHead(200, { 'content-type': contentType, ...cors });
        res.end(bytes);
      },
      () => {
        res.writeHead(404);
        res.end();
      },
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const out: FontServer = {
    url: (file) => `http://127.0.0.1:${port}/${file}`,
    requests,
    failWith: undefined,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };

  return out;
}
