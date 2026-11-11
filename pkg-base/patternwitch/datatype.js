/**
 * @typedef {Object} PatternWitchDoc
 * @property {string}   title
 * @property {number}   height   - number of rows
 * @property {number}   width    - number of columns
 * @property {number[][]} pixels - rows of palette indices
 * @property {string[]} palette  - hex colours, 2..6 entries
 */

export const DEFAULT_PALETTE = ["#f4f1de", "#e07a5f", "#3d405b", "#81b29a"];
export const DEFAULT_SIZE = 50;
export const MIN_SIZE = 4;
export const MAX_SIZE = 200;
export const MIN_COLORS = 2;
export const MAX_COLORS = 6;

export function makePixels(width, height, fill = 0) {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => fill),
  );
}

export const PatternWitchDatatype = {
  init(doc) {
    doc.title = "PatternWitch";
    doc.width = DEFAULT_SIZE;
    doc.height = DEFAULT_SIZE;
    doc.palette = [...DEFAULT_PALETTE];
    doc.pixels = makePixels(DEFAULT_SIZE, DEFAULT_SIZE, 0);
  },
  getTitle(doc) {
    return doc.title || "PatternWitch";
  },
  setTitle(doc, title) {
    doc.title = title;
  },
  markCopy(doc) {
    doc.title = "Copy of " + this.getTitle(doc);
  },
};

export default PatternWitchDatatype;
