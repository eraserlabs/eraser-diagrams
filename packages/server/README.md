# @eraserlabs/server

## Introduction

`@eraserlabs/server` is the unpublished Fastify adapter that exposes `@eraserlabs/resolve` and `@eraserlabs/diagrams` over HTTP. It is for local development and integration tests, not a published package.

## Usage

From the repository root:

```sh
pnpm dev:server
```

The server listens on `http://localhost:8080` by default. Without Chromium it serves:

- `POST /validate`
- `GET /registry`
- `GET /registry/schema/:tag`
- `GET /health`

To enable `POST /render?format=png|html`, provide Chromium. `RENDER_PAGES` defaults to `1` when `CHROMIUM_PATH` is set:

```sh
CHROMIUM_PATH=/path/to/chromium pnpm dev:server
```

PNG responses put a `data:image/png;base64,...` URL in the JSON envelope. Direct `@eraserlabs/diagrams` callers receive a Node `Buffer` instead.

Environment: `HOST`, `PORT`, `BODY_LIMIT`, `RENDER_PAGES`, `RENDER_QUEUE`, `CHROMIUM_PATH`, `FONTS_CONFIG_PATH`. Rendering with `RENDER_PAGES` greater than 0 and no `CHROMIUM_PATH` fails at startup. The route contract is `openapi.yaml`.

Build a container from the repository root:

```sh
docker build -f packages/server/Dockerfile -t eraser-server .
```

The stock image starts without a browser. A rendering image must supply Chromium and set `CHROMIUM_PATH`.
