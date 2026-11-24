// Reading change provenance back: which package version made each of a doc's
// changes (`explain`), and the Writers sidebar that shows it. The writing half,
// which stamps changes, lives in @inkandswitch/patchwork.
export {
  explain,
  explainSummary,
  parseMessage,
  personResolver,
  explainer,
  readChange,
  type ExplainedPerson,
  type ParsedMessage,
  type ReadChange,
  writerResolver,
  type ExplainedChange,
  type ExplainedWriter,
  type WriterSummary,
} from "./explain.js";
export { createHistory, type History, type PersonSummary, type Session } from "./history.js";
export { changeDiff, formatPath, preview, type DiffKind, type DiffRow } from "./diff.js";
export { createSourceMapper, originalPosition, parseLocation, type Location, type Origin } from "./sourcemap.js";
export {
  ago,
  hueOf,
  personLabel,
  renderWriters,
  writerLabel,
  type Contact,
  type ContactOf,
  type NameOf,
  type OriginOf,
  type ViewOptions,
  type WritersCleanup,
} from "./view.js";
export {
  createContacts,
  createNamer,
  packageName,
  plugins,
  readContact,
  Writers,
  WRITERS_COMPONENT_ID,
} from "./sidebar.js";
