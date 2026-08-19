import { useEffect, useState } from 'react';
import type { RegistryInfo } from '@eraserlabs/resolve';
import * as api from '../api.js';
import { propRows, type PropRow } from '../lib/schemaProps.js';

export function ElementPropsExplorer() {
  const [registry, setRegistry] = useState<RegistryInfo | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<PropRow[] | null>(null);

  useEffect(() => {
    api.getRegistry().then((r) => {
      setRegistry(r);
      setSelected(r.tags[0]?.tag ?? null);
    });
  }, []);

  useEffect(() => {
    if (!selected) {
      return;
    }

    setRows(null);
    api.getTagSchema(selected).then((schema) => setRows(propRows(schema)));
  }, [selected]);

  if (!registry) {
    return <p className="note">Loading registry…</p>;
  }

  return (
    <div className="explorer">
      <aside className="explorer__nav">
        <p className="note">{registry.tags.length} tags</p>
        {registry.tags.map((t) => (
          <button
            key={t.tag}
            className={t.tag === selected ? 'tag active' : 'tag'}
            onClick={() => setSelected(t.tag)}
          >
            {t.tag}
          </button>
        ))}
      </aside>

      <div className="explorer__body">
        <h3>{selected}</h3>
        {rows === null ? (
          <p className="note">Loading schema…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>property</th>
                <th>type</th>
                <th>required</th>
                <th>enum</th>
                <th>default</th>
                <th>note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td>
                    <code>{r.name}</code>
                  </td>
                  <td>{r.type}</td>
                  <td>
                    {r.required ? (
                      <span className="badge err">required</span>
                    ) : (
                      <span className="badge muted">optional</span>
                    )}
                  </td>
                  <td>{r.enum ? r.enum.join(' | ') : ''}</td>
                  <td>{typeof r.default === 'undefined' ? '' : JSON.stringify(r.default)}</td>
                  <td>{r.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
