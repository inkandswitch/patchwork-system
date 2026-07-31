import type { AutomergeUrl } from "@automerge/automerge-repo";
import setup, {
  hideLoadingAnimation,
  showErrorScreen,
  showLoadingAnimation,
} from "@inkandswitch/patchwork";

// Published tools are registered in this module-settings doc via
// `pnpm register` from each tool's own repo (see patchwork-tools and
// patchwork-core). Can be overridden for development or forked tool sets
// with `?system-package-list=` or `localStorage.systemPackageListURL`.
const DEFAULT_MODULES_URL =
  "automerge:3XRXFS96oVXe5D4joMyQWAfNeFNN" as AutomergeUrl;

const packageListURL =
  new URLSearchParams(location.search).get("system-package-list") ||
  localStorage.getItem("systemPackageListURL") ||
  DEFAULT_MODULES_URL;

showLoadingAnimation();

window.patchwork = await setup({
  packageListURL,
  accountKey: "gaiosAccountUrl",
  frameToolId: "threepane",
}).catch((error) => {
  showErrorScreen(error, { contact: "chee@inkandswitch.com" });
  throw error;
});

hideLoadingAnimation();
