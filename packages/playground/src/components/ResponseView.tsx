import type { ResolveResult, ValidationResult } from '@eraserlabs/resolve';
import { IssueTable } from './IssueTable.js';
import { RenderPreview } from './RenderPreview.js';

type AnyResult = (ResolveResult | ValidationResult) & {
  entities?: ResolveResult['entities'];
  connections?: ResolveResult['connections'];
  icons?: ResolveResult['icons'];
  meta?: ResolveResult['meta'];
};

export function ResponseView({ result }: { result: AnyResult }) {
  const entities = result.ok ? result.entities : undefined;
  const connections = result.ok ? result.connections : undefined;
  const payload = entities && connections ? { entities, connections } : undefined;

  return (
    <div className="response">
      <p>
        <span className={`badge ${result.ok ? 'ok' : 'err'}`}>{result.ok ? 'ok' : 'failed'}</span>
        {result.meta ? (
          <span className="badge muted">
            {result.meta.elementCount} elements · {result.meta.iconsInlined} icons
          </span>
        ) : null}
      </p>

      <IssueTable title="errors" issues={result.errors} kind="err" />
      <IssueTable title="warnings" issues={result.warnings} kind="warn" />

      {payload ? (
        <>
          <RenderPreview
            entities={payload.entities}
            connections={payload.connections}
            icons={result.icons ?? {}}
          />
          <details>
            <summary>
              payload ({payload.entities.length} entities · {payload.connections.length}{' '}
              connections)
            </summary>
            <pre>{JSON.stringify({ ...payload, icons: result.icons }, null, 2)}</pre>
          </details>
        </>
      ) : null}
    </div>
  );
}
