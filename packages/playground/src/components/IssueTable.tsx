import type { Issue } from '@eraserlabs/resolve';

export function IssueTable({
  title,
  issues,
  kind,
}: {
  title: string;
  issues?: Issue[];
  kind: 'err' | 'warn';
}) {
  if (!issues || issues.length === 0) {
    return null;
  }

  return (
    <div className="issues">
      <p>
        <span className={`badge ${kind}`}>
          {title} ({issues.length})
        </span>
      </p>
      <table>
        <thead>
          <tr>
            <th>code</th>
            <th>path</th>
            <th>message</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((i, n) => (
            <tr key={n}>
              <td>{i.code}</td>
              <td>{i.path}</td>
              <td>
                {i.message}
                {i.suggestion ? <em> → {i.suggestion}</em> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
