// The URL of each frame in a captured stack, top first. Reads V8's
// "    at fn (url:line:col)" lines and the "fn@url:line:col" lines of
// SpiderMonkey and JavaScriptCore alike: only the url:line:col part matters.
const FRAME = /((?:https?|blob):\/\/[^\s()]+?):(\d+):(\d+)/g;

export type Frame = { url: string; line: number; column: number };

export function frames(stack: string): Frame[] {
  return Array.from(stack.matchAll(FRAME), (m) => ({ url: m[1]!, line: Number(m[2]), column: Number(m[3]) }));
}

export function frameUrls(stack: string): string[] {
  return frames(stack).map((frame) => frame.url);
}
