import { createSignal, Show } from "solid-js";
import { Button } from "./button";

export interface Crop {
  x: number;
  y: number;
  size: number;
}

interface AvatarCropperProps {
  src: string;
  onCancel: () => void;
  onConfirm: (crop: Crop) => void;
}

const VIEWPORT = 260;
const MAX_ZOOM = 4;

export function AvatarCropper(props: AvatarCropperProps) {
  const [natural, setNatural] = createSignal<{ w: number; h: number }>();
  const [zoom, setZoom] = createSignal(1);
  const [offset, setOffset] = createSignal({ x: 0, y: 0 });

  const scale = () => {
    const n = natural();
    return n ? (VIEWPORT / Math.min(n.w, n.h)) * zoom() : 1;
  };
  const size = () => {
    const n = natural()!;
    return { w: n.w * scale(), h: n.h * scale() };
  };

  const clamp = (next: { x: number; y: number }) => {
    const { w, h } = size();
    return {
      x: Math.min(0, Math.max(VIEWPORT - w, next.x)),
      y: Math.min(0, Math.max(VIEWPORT - h, next.y)),
    };
  };

  const onLoad = (e: Event & { currentTarget: HTMLImageElement }) => {
    const img = e.currentTarget;
    setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    const s = scale();
    setOffset({
      x: (VIEWPORT - img.naturalWidth * s) / 2,
      y: (VIEWPORT - img.naturalHeight * s) / 2,
    });
  };

  const onPointerDown = (e: PointerEvent & { currentTarget: HTMLElement }) => {
    if (!natural()) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = { ...offset(), px: e.clientX, py: e.clientY };
    const onMove = (move: PointerEvent) => {
      setOffset(
        clamp({
          x: start.x + move.clientX - start.px,
          y: start.y + move.clientY - start.py,
        })
      );
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const setZoomAroundCenter = (next: number) => {
    if (!natural()) return;
    const previous = scale();
    setZoom(Math.min(MAX_ZOOM, Math.max(1, next)));
    const ratio = scale() / previous;
    const o = offset();
    setOffset(
      clamp({
        x: VIEWPORT / 2 - (VIEWPORT / 2 - o.x) * ratio,
        y: VIEWPORT / 2 - (VIEWPORT / 2 - o.y) * ratio,
      })
    );
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    setZoomAroundCenter(zoom() * (1 - e.deltaY / 500));
  };

  const onConfirm = () => {
    const o = offset();
    const s = scale();
    props.onConfirm({
      x: -o.x / s,
      y: -o.y / s,
      size: VIEWPORT / s,
    });
  };

  return (
    <>
      <div class="modal-backdrop" onClick={props.onCancel} />
      <div class="modal cropper-modal">
        <p class="modal-title">Crop avatar</p>
        <div
          class="cropper-viewport"
          onPointerDown={onPointerDown}
          onWheel={onWheel}
        >
          <img
            class="cropper-image"
            src={props.src}
            onLoad={onLoad}
            draggable={false}
            style={
              natural()
                ? {
                    width: `${size().w}px`,
                    height: `${size().h}px`,
                    transform: `translate(${offset().x}px, ${offset().y}px)`,
                  }
                : { visibility: "hidden" }
            }
          />
          <div class="cropper-mask" />
        </div>
        <Show when={natural()}>
          <input
            class="cropper-zoom"
            type="range"
            min="1"
            max={MAX_ZOOM}
            step="0.01"
            value={zoom()}
            onInput={(e) => setZoomAroundCenter(e.currentTarget.valueAsNumber)}
          />
        </Show>
        <div class="modal-actions">
          <Button variant="secondary" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={!natural()}>
            Save
          </Button>
        </div>
      </div>
    </>
  );
}
