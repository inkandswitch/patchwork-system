// esbuild's `.css` text loader (see esbuild/options.ts) turns a `.css` import
// into the stylesheet's source as a string.
declare module "*.css" {
  const content: string;
  export default content;
}
