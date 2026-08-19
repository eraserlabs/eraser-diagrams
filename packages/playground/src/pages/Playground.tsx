import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import scenarios from 'virtual:scenarios';
import type { ResolveResult } from '@eraserlabs/resolve';
import { ScenarioPicker } from '../components/ScenarioPicker.js';
import { RequestEditor } from '../components/RequestEditor.js';
import { ResponseView } from '../components/ResponseView.js';
import { getResolver } from '../lib/engine.js';

function scenarioIndexFromParam(param: string | null): number {
  const index = scenarios.findIndex((scenario) => scenario.id === param);

  return index >= 0 ? index : 0;
}

export function Playground() {
  const [params, setParams] = useSearchParams();
  const [index, setIndex] = useState(() => scenarioIndexFromParam(params.get('scenario')));
  const [request, setRequest] = useState(() => JSON.stringify(scenarios[index]!.input, null, 2));
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [showRequest, setShowRequest] = useState(true);

  // Always resolve — the result carries validation errors/warnings either way, and ResponseView
  // surfaces them above the preview.
  const run = useCallback(async (source: string) => {
    let body: unknown;

    try {
      body = JSON.parse(source);
    } catch (e) {
      setParseError((e as Error).message);
      setResult(null);

      return;
    }

    setParseError(null);
    // The engine runs locally — the playground is already a browser.
    const resolver = await getResolver();
    setResult(await resolver.resolve(body));
  }, []);

  // Every selected scenario resolves immediately (including the initial one); the button below
  // re-runs after hand-edits to the request JSON.
  useEffect(() => {
    void run(JSON.stringify(scenarios[index]!.input, null, 2));
  }, [index, run]);

  function pick(i: number) {
    setIndex(i);
    setRequest(JSON.stringify(scenarios[i]!.input, null, 2));
    setResult(null);
    setParseError(null);
    setParams({ scenario: scenarios[i]!.id }, { replace: true });
  }

  return (
    <>
      <div className="toolbar">
        <ScenarioPicker scenarios={scenarios} value={index} onChange={pick} />
        <button className="primary" onClick={() => void run(request)}>
          Run
        </button>
        <button aria-pressed={!showRequest} onClick={() => setShowRequest((v) => !v)}>
          {showRequest ? 'Hide request' : 'Show request'}
        </button>
        <span className="note">{scenarios[index]!.description}</span>
      </div>

      <main className={showRequest ? 'split' : 'split split--single'}>
        {showRequest ? (
          <section className="pane">
            <h2>Request</h2>
            <RequestEditor value={request} onChange={setRequest} />
          </section>
        ) : null}
        <section className="pane">
          <h2>Response</h2>
          <div className="out">
            {parseError ? (
              <>
                <span className="badge err">Invalid JSON</span>
                <pre>{parseError}</pre>
              </>
            ) : result ? (
              <ResponseView result={result} />
            ) : (
              'Resolving…'
            )}
          </div>
        </section>
      </main>
    </>
  );
}
