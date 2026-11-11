export function docIdFromAutomergeUrl(url: string) {
  return url.replace(/^automerge:/, "");
}
