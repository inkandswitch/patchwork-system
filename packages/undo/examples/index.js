// The example tools as one Patchwork module.
import { plugins as canvas } from "./canvas.js";
import { plugins as form } from "./form.js";
import { plugins as text } from "./text.js";

export const plugins = [...text, ...canvas, ...form];
