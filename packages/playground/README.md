# @eraserlabs/playground

## Introduction

`@eraserlabs/playground` is the unpublished React app for exploring `eraser-diagrams` locally. It is not part of the published packages.

## Usage

From the repository root:

```sh
pnpm dev
```

Then open `http://localhost:5173`.

The playground edits fixture documents, runs `resolve` and `validate` in the browser against the stock Eraser profile, and shows the local tag registry plus an HTTP reference generated from `packages/server/openapi.yaml`.

Keep `@eraserlabs/server` on port `8080` for the registry-backed schema explorer and the documented HTTP endpoints, or set `SERVER_PORT` to match a different port. Vite proxies icon requests to the public Eraser asset bucket; a missing icon follows the resolver's `onUnknownIcon` policy (placeholder by default).
