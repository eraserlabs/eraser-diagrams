// Enforces package boundaries for the whole monorepo. One repo, no plan to split; the packages
// are published to npm separately, so each must stay consumable on its own: cross-package imports
// only via package names, resolving through declared dependencies. server and playground are
// private (deployment and dev UI, never published) and nothing may import them. Layering runs
// contracts and helpers (protocol, utils) at the bottom, engines (resolve, render, layout) above
// them, and the diagrams orchestrator plus its CLI on top — lower layers never import upward.
// diagrams-cli depends on diagrams and resolve only.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-unresolvable-eraser-imports',
      comment:
        'An `@eraserlabs/*` import the resolver cannot reach is either undeclared in package.json or ' +
        'not yet built — and boundary violations start life as exactly this, since the forbidden ' +
        "package is never in the importer's dependencies. Declare the dependency (and let the " +
        'boundary rules below judge it) or remove the import.',
      severity: 'error',
      from: {},
      // Bundler-flavored imports with a query suffix (Vite `?url` and friends) are exempt: the
      // node resolver cannot see them, but the bundler resolves them fine.
      to: { couldNotResolve: true, path: '^@eraserlabs/', pathNot: '[?]' },
    },
    {
      name: 'no-circular',
      comment: 'Circular dependencies are forbidden.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'server-no-playground',
      comment: 'The server may not import the dev-only playground.',
      severity: 'error',
      from: { path: '^packages/server/src' },
      to: { path: '^packages/playground/' },
    },
    {
      name: 'playground-no-server',
      comment:
        'The playground talks to the server over HTTP only, never by importing its source.',
      severity: 'error',
      from: { path: '^packages/playground/src' },
      to: { path: '^packages/server/' },
    },
    {
      name: 'public-no-private',
      comment:
        'Contract and engine packages sit below the orchestrator layer: they may never depend on ' +
        'diagrams, the CLI, the private server, or the dev UI.',
      severity: 'error',
      from: {
        path: '^packages/(protocol|resolve|render|layout|utils)/src',
      },
      to: { path: '^packages/(server|playground|diagrams|diagrams-cli)/' },
    },
    {
      name: 'cli-imports-diagrams-and-resolve-only',
      comment:
        'The CLI package imports @eraserlabs/diagrams and @eraserlabs/resolve; no engine or dev packages.',
      severity: 'error',
      from: { path: '^packages/diagrams-cli/src' },
      to: {
        path: '^packages/(render|layout|server|playground|utils)/',
      },
    },
    {
      name: 'protocol-is-a-leaf',
      comment:
        'The portable protocol owns contracts and vocabulary only; it must not depend on an implementation package.',
      severity: 'error',
      from: { path: '^packages/protocol/src' },
      to: {
        path: '^packages/(resolve|render|layout|server|playground|diagrams|utils)/',
      },
    },
    {
      name: 'utils-is-a-leaf',
      comment:
        'The shared helpers are the bottom of the stack: every other package may depend on utils, ' +
        'and utils may depend on none of them.',
      severity: 'error',
      from: { path: '^packages/utils/src' },
      to: { path: '^packages/(?!utils/)[^/]+/' },
    },
    {
      name: 'utils-no-node-builtins',
      comment:
        'utils is bundled into the render browser IIFE through layout; no node:* builtins anywhere.',
      severity: 'error',
      from: { path: '^packages/utils/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'resolve-no-fastify',
      comment: 'The pure engine must not depend on the server framework.',
      severity: 'error',
      from: { path: '^packages/resolve/src' },
      to: { path: 'node_modules/(fastify|@fastify|pino)' },
    },
    {
      name: 'resolve-no-node-builtins',
      comment:
        'The engine is platform-pure: all IO is injected, no node:* builtins anywhere.',
      severity: 'error',
      from: { path: '^packages/resolve/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'render-imports-layout-and-protocol-only',
      comment:
        'render implements protocol contracts and may pull in layout geometry; it imports no ' +
        'other implementation package.',
      severity: 'error',
      from: { path: '^packages/render/src' },
      to: { path: '^packages/(resolve|server|playground)/' },
    },
  ],
  options: {
    // Workspace `@eraserlabs/*` imports resolve through node_modules symlinks into each package's
    // dist/, so those modules must stay IN the graph for the boundary rules above to see them.
    // doNotFollow keeps them as endpoints without descending into their internals. Entry points
    // are constrained to packages/*/src by the depcruise script instead of includeOnly/exclude,
    // which would drop these endpoints (and the edges to them) entirely.
    doNotFollow: { path: 'node_modules|/dist/' },
    // The workspace packages expose themselves through `exports` maps with `types`/`default`
    // conditions; without these the resolver reports every `@eraserlabs/*` import as unresolvable.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'node', 'default'],
      mainFields: ['module', 'main', 'types'],
    },
    tsConfig: { fileName: 'tsconfig.base.json' },
    // Type-only cycles do not survive compilation; keep this check focused on runtime cycles.
    tsPreCompilationDeps: false,
    combinedDependencies: true,
  },
};
