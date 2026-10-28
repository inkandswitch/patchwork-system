// The one way content is hashed, by whoever builds a file list and by the service worker
// checking what it serves: SHA-256 over the bytes, base64url without padding. A file list's own
// hash, the `~listHash` in a pinned path, is this too.

/** Bytes as served: strings as UTF-8, which is what a Response body of a string sends. */
export function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

export async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
