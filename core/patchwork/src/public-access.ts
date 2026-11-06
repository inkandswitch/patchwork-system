import type { Repo } from "@automerge/automerge-repo/slim";
import {
  onPublicReaderStatus,
  publicReaderCanRead,
} from "@inkandswitch/patchwork-bootloader";
import {
  publicAccessChanged,
  setPublicAccess,
} from "@inkandswitch/patchwork-elements";

/**
 * Let patchwork-view's access gate open public docs: it asks the public reader
 * `repo` is connected to whether it can read a doc, and checks every waiting
 * view again each time the reader has read more of keyhive, so a doc made
 * public after it was opened opens too.
 */
export function gatePublicDocsOnReader(repo: Repo): void {
  setPublicAccess((url) => publicReaderCanRead(repo, url));
  let relayed = -1;
  onPublicReaderStatus((status) => {
    if (status.relayed === relayed) return;
    relayed = status.relayed;
    publicAccessChanged();
  });
}
