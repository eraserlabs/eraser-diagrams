import openapi from 'virtual:openapi';
import type { OpenApiOperation } from '../types.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function Operation({ method, path, op }: { method: string; path: string; op: OpenApiOperation }) {
  return (
    <div className="endpoint">
      <div className="endpoint__head">
        <span className={`method method--${method}`}>{method.toUpperCase()}</span>
        <code className="endpoint__path">{path}</code>
        {op.summary ? <span className="endpoint__summary">{op.summary}</span> : null}
      </div>

      {op.parameters?.length ? (
        <div className="endpoint__block">
          <h5>Path parameters</h5>
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th>in</th>
                <th>required</th>
                <th>type</th>
              </tr>
            </thead>
            <tbody>
              {op.parameters.map((p) => (
                <tr key={p.name}>
                  <td>
                    <code>{p.name}</code>
                  </td>
                  <td>{p.in}</td>
                  <td>{p.required ? 'yes' : 'no'}</td>
                  <td>{p.schema?.type ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {op.requestBody ? (
        <div className="endpoint__block">
          <h5>Request body</h5>
          <p className="note">JSON{op.requestBody.required ? ' · required' : ''}</p>
        </div>
      ) : null}

      {op.responses ? (
        <div className="endpoint__block">
          <h5>Responses</h5>
          <table>
            <thead>
              <tr>
                <th>status</th>
                <th>description</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(op.responses).map(([code, r]) => (
                <tr key={code}>
                  <td>
                    <span className={`status status--${code[0]}`}>{code}</span>
                  </td>
                  <td>{r.description ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export function OpenApiReference() {
  const paths: Record<string, Record<string, OpenApiOperation>> = openapi.paths ?? {};
  const base = openapi.servers?.[0]?.url ?? '';

  return (
    <div className="openapi">
      <header className="openapi__head">
        <h3>
          {openapi.info?.title} <span className="badge muted">v{openapi.info?.version}</span>
        </h3>
        {openapi.info?.description ? <p className="note">{openapi.info.description}</p> : null}
        {base ? (
          <p className="note">
            Base URL: <code>{base}</code>
          </p>
        ) : null}
      </header>

      {Object.entries(paths).flatMap(([path, ops]) =>
        METHODS.filter((m) => ops[m]).map((m) => (
          <Operation key={`${m} ${path}`} method={m} path={`${base}${path}`} op={ops[m]!} />
        )),
      )}
    </div>
  );
}
