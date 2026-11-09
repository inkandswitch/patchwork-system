// The URL of each frame in a captured stack, top first. Reads V8's
// "    at fn (url:line:col)" lines and the "fn@url:line:col" lines of
// SpiderMonkey and JavaScriptCore alike: only the url:line:col part matters.
const FRAME = /((?:https?|blob):\/\/[^\s()]+?):\d+:\d+/g;

export function frameUrls(stack: string): string[] {
  return Array.from(stack.matchAll(FRAME), (m) => m[1]);
}
