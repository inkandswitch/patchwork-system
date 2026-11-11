import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import type { TLCursorProps } from "@tldraw/tldraw";

// Parses a userId of the form `${contactUrl}-${peerId}` to recover contactUrl
// and actorId (see useContactInfo in tool.tsx for why userIds are composed).
export function splitPresenceUserId(userId: string): {
  contactUrl?: AutomergeUrl;
  actorId?: string;
} {
  if (!userId.startsWith("automerge:")) return { actorId: userId };
  const i = userId.indexOf("-");
  if (i === -1) return { contactUrl: userId as AutomergeUrl };
  return {
    contactUrl: userId.slice(0, i) as AutomergeUrl,
    actorId: userId.slice(i + 1),
  };
}

/**
 * Collaborator cursor override: tldraw's default arrow, but the nametag is
 * replaced by the shared "contact-cursor" token (rendered live from the
 * peer's contact doc), so remote cursors look the same on canvases as in
 * text editors. The arrow paths are copied from tldraw's own cursor SVG --
 * the shared symbol DefaultCursor references has a runtime-generated id we
 * can't reach from here.
 */
export function ContactCollaboratorCursor({
  className,
  point,
  zoom,
  color,
  name,
  userId,
}: TLCursorProps) {
  if (!point) return null;
  const { contactUrl } = splitPresenceUserId(userId);
  return (
    <div
      className={
        className ? `tl-overlays__item ${className}` : "tl-overlays__item"
      }
      style={{
        transform: `translate(${point.x}px, ${point.y}px) scale(${1 / zoom})`,
      }}
    >
      <svg
        className="tl-cursor"
        width="32"
        height="32"
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
      >
        {/* translate(-12,-12) puts the arrow tip at the presence point (the
            shadow copy sits 1px off), matching tldraw's CursorDef -- and
            keeps the arrow clear of the nametag slot below. */}
        <g fill="rgba(0,0,0,.2)" transform="translate(-11,-11)">
          <path d="m12 24.4219v-16.015l11.591 11.619h-6.781l-.411.124z" />
          <path d="m21.0845 25.0962-3.605 1.535-4.682-11.089 3.686-1.553z" />
        </g>
        <g style={{ color }} transform="translate(-12,-12)">
          <path
            d="m12 24.4219v-16.015l11.591 11.619h-6.781l-.411.124z"
            fill="white"
          />
          <path
            d="m21.0845 25.0962-3.605 1.535-4.682-11.089 3.686-1.553z"
            fill="white"
          />
          <path
            d="m19.751 24.4155-1.844.774-3.1-7.374 1.841-.775z"
            fill="currentColor"
          />
          <path
            d="m13 10.814v11.188l2.969-2.866.428-.139h4.768z"
            fill="currentColor"
          />
        </g>
      </svg>
      {contactUrl ? (
        // Same offset as tldraw's .tl-nametag so the token hangs off the
        // arrow tip.
        <div style={{ position: "absolute", top: 16, left: 13 }}>
          {/* @ts-expect-error Custom element from @inkandswitch/patchwork-elements */}
          <patchwork-view doc-url={contactUrl} tool-id="contact-cursor" />
        </div>
      ) : (
        name && (
          <div className="tl-nametag" style={{ backgroundColor: color }}>
            {name}
          </div>
        )
      )}
    </div>
  );
}
