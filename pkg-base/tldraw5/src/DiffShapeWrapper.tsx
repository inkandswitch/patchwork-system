import { createContext, forwardRef, useContext } from "react";
import {
  DefaultShapeWrapper,
  useValue,
  type Atom,
  type TLShapeId,
  type TLShapeWrapperProps,
} from "@tldraw/tldraw";

export type DiffStatus = "added" | "changed" | "deleted";

// Per-tool atom mapping each shape id to its diff status. It lives in a tldraw
// `atom` (not React state) so the wrapper can read it via `useValue` and only
// the shapes whose status actually changed re-render. It reaches the wrapper
// through context because tldraw instantiates `ShapeWrapper` internally — props
// can't be passed to it, but context (which flows down from `<Tldraw>`) can.
export type DiffStatusAtom = Atom<Map<TLShapeId, DiffStatus>>;

export const DiffStatusContext = createContext<DiffStatusAtom | null>(null);

// Wraps every shape's DOM and tags it with a `tl-diff-*` class so a CSS
// `drop-shadow` glow can hug the shape outline (added / changed) or fade it out
// (deleted ghosts). Re-uses `DefaultShapeWrapper` so all default behaviour is
// preserved.
export const DiffShapeWrapper = forwardRef<HTMLDivElement, TLShapeWrapperProps>(
  function DiffShapeWrapper({ children, shape, isBackground }, ref) {
    const statusAtom = useContext(DiffStatusContext);
    const status = useValue(
      "diff status",
      () => statusAtom?.get().get(shape.id),
      [statusAtom, shape.id]
    );
    return (
      <DefaultShapeWrapper
        ref={ref}
        shape={shape}
        isBackground={isBackground}
        className={status ? `tl-diff-${status}` : undefined}
      >
        {children}
      </DefaultShapeWrapper>
    );
  }
);
