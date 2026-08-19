import { useEffect, useRef, useState } from 'react';
// Side effect: attaches window.__eraser. Served from source in dev (vite aliases), so pipeline
// edits HMR straight into the next render.
import '@eraserlabs/render/browser';
import { pageSetup } from '../lib/engine.js';
import { playgroundFonts } from '../lib/fonts.js';

let configured = false;

const MIN_SCALE = 0.05;
const MAX_SCALE = 4;
const BUTTON_STEP = Math.SQRT2;
const FIT_PADDING = 24;

interface SceneSize {
  width: number;
  height: number;
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * The real render pipeline, run directly in this document — no iframe. The template CSS is
 * @scope'd to its mount hosts and the base sheet matches the playground's own resets, so nothing
 * leaks either way; meanwhile iframes LIE about the pipeline's output: Chromium-family browsers
 * skip SVG filters inside <mask> content when the document is an iframe (hard wash edges that the
 * CLI, artifacts, and any top-level document render correctly). Painting inline shows the truth.
 *
 * run() mounts #eraser-scene onto document.body; we relocate it into the panel afterwards. The
 * sequence guard keeps a slow older run from stealing the scene back from a newer one.
 *
 * Zoom is paint-only: the scene keeps its natural layout and a CSS scale rides on the host, with
 * a sizer div holding the scaled footprint so the viewport's native scrollbars stay honest. A new
 * scene auto-fits; pinch (ctrl/cmd-wheel — what macOS trackpads emit) zooms around the cursor.
 */
export function RenderPreview({
  entities,
  connections,
  icons,
}: {
  entities: unknown[];
  connections: unknown[];
  icons: Record<string, string>;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [sceneSize, setSceneSize] = useState<SceneSize | null>(null);
  const scaleRef = useRef(1);
  const sceneSizeRef = useRef<SceneSize | null>(null);
  const runSeq = useRef(0);

  /** Set a new scale, keeping `anchor` (viewport coords; default center) over the same scene point. */
  function applyZoom(next: number, anchor?: { x: number; y: number }): void {
    const view = viewport.current;
    const clamped = clampScale(next);

    if (!view || clamped === scaleRef.current) {
      return;
    }

    const at = anchor ?? { x: view.clientWidth / 2, y: view.clientHeight / 2 };
    const ratio = clamped / scaleRef.current;
    const left = (view.scrollLeft + at.x) * ratio - at.x;
    const top = (view.scrollTop + at.y) * ratio - at.y;
    scaleRef.current = clamped;
    setScale(clamped);
    // The sizer's new footprint lands after React commits; scroll once layout can hold it.
    requestAnimationFrame(() => {
      view.scrollLeft = left;
      view.scrollTop = top;
    });
  }

  /** Largest scale (capped at 1:1) that shows the whole scene inside the viewport. */
  function fitScale(size: SceneSize | null = sceneSizeRef.current): number {
    const view = viewport.current;

    if (!view || !size || size.width === 0 || size.height === 0) {
      return 1;
    }

    return clampScale(
      Math.min(
        1,
        (view.clientWidth - FIT_PADDING) / size.width,
        (view.clientHeight - FIT_PADDING) / size.height,
      ),
    );
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: reruns are keyed to the document; fitScale reads live layout and must not retrigger renders.
  useEffect(() => {
    const seq = ++runSeq.current;

    void (async () => {
      try {
        if (!configured) {
          window.__eraser.setup(pageSetup);
          await window.__eraser.registerFonts(playgroundFonts());
          configured = true;
        }

        await window.__eraser.run({ entities, connections, icons } as Parameters<
          typeof window.__eraser.run
        >[0]);

        if (seq !== runSeq.current) {
          return;
        }

        const scene = document.getElementById('eraser-scene');

        if (scene && host.current) {
          host.current.replaceChildren(scene);
          const size = { width: scene.offsetWidth, height: scene.offsetHeight };
          sceneSizeRef.current = size;
          setSceneSize(size);

          const fitted = fitScale(size);
          scaleRef.current = fitted;
          setScale(fitted);
          viewport.current?.scrollTo(0, 0);
        }

        setError(null);
      } catch (e) {
        if (seq === runSeq.current) {
          setError((e as Error).message);
        }
      }
    })();
  }, [entities, connections, icons]);

  // macOS trackpad pinch arrives as a ctrlKey wheel event; cmd/ctrl + scroll wheel zooms too.
  // Non-passive so preventDefault can stop the browser's page zoom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listener lifetime is mount-scoped; handlers read refs, not render state.
  useEffect(() => {
    const view = viewport.current;

    if (!view) {
      return;
    }

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }

      event.preventDefault();
      const rect = view.getBoundingClientRect();
      applyZoom(scaleRef.current * Math.exp(-event.deltaY * 0.01), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };

    view.addEventListener('wheel', onWheel, { passive: false });

    return () => view.removeEventListener('wheel', onWheel);
  }, []);

  if (error) {
    return <pre className="render-preview render-preview--error">{error}</pre>;
  }

  return (
    <div className="render-preview-wrap">
      <div className="render-preview__controls">
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => applyZoom(scaleRef.current / BUTTON_STEP)}
        >
          −
        </button>
        <span className="render-preview__scale">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => applyZoom(scaleRef.current * BUTTON_STEP)}
        >
          +
        </button>
        <button type="button" onClick={() => applyZoom(fitScale())}>
          Fit
        </button>
        <button type="button" onClick={() => applyZoom(1)}>
          100%
        </button>
      </div>
      <div className="render-preview" ref={viewport}>
        <div
          className="render-preview__sizer"
          style={
            sceneSize
              ? { width: sceneSize.width * scale, height: sceneSize.height * scale }
              : undefined
          }
        >
          <div ref={host} style={{ transform: `scale(${scale})`, transformOrigin: '0 0' }} />
        </div>
      </div>
    </div>
  );
}
