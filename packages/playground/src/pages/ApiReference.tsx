import { useNavigate, useParams } from 'react-router-dom';
import { ElementPropsExplorer } from '../components/ElementPropsExplorer.js';
import { OpenApiReference } from '../components/OpenApiReference.js';

export function ApiReference() {
  const { section } = useParams<{ section: string }>();
  const nav = useNavigate();
  const rest = section === 'rest';

  return (
    <div className="reference">
      <div className="toolbar">
        <label>
          <input type="radio" checked={!rest} onChange={() => nav('/reference/elements')} /> Element
          props
        </label>
        <label>
          <input type="radio" checked={rest} onChange={() => nav('/reference/rest')} /> REST API
        </label>
        <span className="note">
          Element props are read live from the resolver's schema; REST from the OpenAPI.
        </span>
      </div>

      {rest ? <OpenApiReference /> : <ElementPropsExplorer />}
    </div>
  );
}
