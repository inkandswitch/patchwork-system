// Reading change provenance back: which package version made each of a doc's
// changes (`explain`), and the Writers sidebar that shows it. The writing half,
// which stamps changes, lives in @inkandswitch/patchwork.
export {
  explain,
  explainSummary,
  parseMessage,
  writerResolver,
  type ExplainedChange,
  type ExplainedWriter,
  type WriterSummary,
} from "./explain.js";
export { createHistory, type History } from "./history.js";
export { renderWriters, writerLabel, type NameOf, type WritersCleanup } from "./view.js";
export { createNamer, packageName, plugins, Writers, WRITERS_COMPONENT_ID } from "./sidebar.js";
