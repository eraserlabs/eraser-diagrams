import type { FastifyInstance } from 'fastify';
import { SEVERITY } from '@eraserlabs/resolve';
import type { OutputRequest, Renderer, RenderRequest } from '@eraserlabs/diagrams';

export interface RenderRouteOptions {
  /** Warm pool size — renders beyond `poolSize + queueLimit` in flight are shed with a 503. */
  poolSize: number;
  queueLimit: number;
}

/**
 * The body is the render request. `?format` is the transport's way of selecting an output, so it
 * overrides whatever `outputs` the body carried. A document is always an object envelope, so an
 * array body — which has nowhere to put `outputs` anyway — is not wrapped here: it flows through
 * untouched and resolve answers with `E_ENVELOPE`.
 */
function renderRequestFrom<const O extends OutputRequest>(
  body: unknown,
  outputs: O,
): RenderRequest & { outputs: O } {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return { ...(body as object), outputs } as RenderRequest & { outputs: O };
  }

  // Not a document at all: hand it over untouched so resolve answers with the envelope error.
  return body as RenderRequest & { outputs: O };
}

/**
 * `POST /render?format=png|html` — the product path: resolve, render on a warm page, and answer
 * with the artifact in a JSON envelope (PNG travels as a directly openable data URL). Input
 * problems come back as the same `ok:false` envelope `/validate` uses; only load shedding is a
 * transport-level status.
 */
export function registerRender(
  app: FastifyInstance,
  renderer: Renderer,
  options: RenderRouteOptions,
): void {
  let inflight = 0;

  app.post<{ Querystring: { format?: string } }>('/render', async (request, reply) => {
    const format = request.query.format ?? 'png';

    if (format !== 'png' && format !== 'html') {
      return reply.code(400).send({
        ok: false,
        errors: [
          {
            code: 'E_BAD_FORMAT',
            severity: SEVERITY.ERROR,
            path: '/',
            message: `Unknown format "${format}"; expected "png" or "html".`,
          },
        ],
        warnings: [],
      });
    }

    if (inflight >= options.poolSize + options.queueLimit) {
      return reply
        .code(503)
        .header('retry-after', '1')
        .send({
          ok: false,
          errors: [
            {
              code: 'E_OVERLOADED',
              severity: SEVERITY.ERROR,
              path: '/',
              message: 'Render capacity exhausted; retry shortly.',
            },
          ],
          warnings: [],
        });
    }

    inflight += 1;

    try {
      const outcome =
        format === 'html'
          ? await renderer.render(renderRequestFrom(request.body, { html: true }))
          : await renderer.render(renderRequestFrom(request.body, { png: true }));

      if (!outcome.ok) {
        return reply.code(200).send(outcome);
      }

      if ('html' in outcome) {
        return reply
          .code(200)
          .send({ ok: true, format, html: outcome.html, warnings: outcome.warnings });
      }

      return reply.code(200).send({
        ok: true,
        format,
        png: `data:image/png;base64,${outcome.png.toString('base64')}`,
        warnings: outcome.warnings,
      });
    } finally {
      inflight -= 1;
    }
  });
}
