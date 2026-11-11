/**
 * User color palette for presence indicators (cursors, avatars, etc.)
 *
 * Colors are selected to:
 * - Be easily distinguishable from each other
 * - Work well on both light and dark backgrounds
 * - Be accessible and readable
 * - Look professional and modern
 */

export const USER_COLOR_PALETTE = [
  { name: "Sky Blue", value: "hsl(200, 70%, 50%)" },
  { name: "Coral", value: "hsl(10, 75%, 58%)" },
  { name: "Emerald", value: "hsl(145, 70%, 45%)" },
  { name: "Violet", value: "hsl(270, 70%, 55%)" },
  { name: "Amber", value: "hsl(38, 85%, 50%)" },
  { name: "Rose", value: "hsl(350, 70%, 55%)" },
  { name: "Teal", value: "hsl(178, 70%, 45%)" },
  { name: "Indigo", value: "hsl(235, 70%, 58%)" },
  { name: "Lime", value: "hsl(85, 70%, 45%)" },
  { name: "Fuchsia", value: "hsl(310, 70%, 55%)" },
  { name: "Orange", value: "hsl(25, 80%, 52%)" },
  { name: "Cyan", value: "hsl(188, 75%, 48%)" },
] as const;

/**
 * Generate a deterministic color from a string (like a contact url).
 * Only used to seed `contact.color` at signup -- presence rendering never
 * derives colors, it reads `contact.color` from the account.
 */
export function generateColorFromString(str: string): string {
  const hash = Math.abs(
    str.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)
  );
  const colorIndex = hash % USER_COLOR_PALETTE.length;
  return USER_COLOR_PALETTE[colorIndex].value;
}

/**
 * Get a default color for a user (picks from palette based on index)
 */
export function getDefaultUserColor(index: number): string {
  return USER_COLOR_PALETTE[index % USER_COLOR_PALETTE.length].value;
}

export function getRandomUserColor(): string {
  return USER_COLOR_PALETTE[
    Math.floor(Math.random() * USER_COLOR_PALETTE.length)
  ].value;
}

/**
 * Validate if a string is a valid HSL color
 */
export function isValidHslColor(color: string): boolean {
  return /^hsl\(\s*\d+\s*,\s*\d+%\s*,\s*\d+%\s*\)$/.test(color);
}

/**
 * Parse HSL values from a color string
 */
export function parseHslColor(
  color: string
): { h: number; s: number; l: number } | null {
  const match = color.match(/^hsl\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%\s*\)$/);
  if (!match) return null;
  return {
    h: parseInt(match[1], 10),
    s: parseInt(match[2], 10),
    l: parseInt(match[3], 10),
  };
}

/**
 * Create an HSL color string from values
 */
export function createHslColor(h: number, s: number, l: number): string {
  return `hsl(${h}, ${s}%, ${l}%)`;
}
