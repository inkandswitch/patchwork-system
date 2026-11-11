// Byte encodings keyline passes around, without Node's Buffer.

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export const b64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

export const unb64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));

export const equal = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);
