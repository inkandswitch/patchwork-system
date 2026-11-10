export { installProvenance, composeMessage, AUTHORS, WRITERS, type Author, type ProvenanceOptions } from "./stamp.js";
export {
  explain,
  explainSummary,
  parseMessage,
  type ExplainedChange,
  type ExplainedWriter,
  type WriterSummary,
} from "@inkandswitch/patchwork-provenance";
export { findWriter, packageRoot, writerKey, type Writer, type WriterContext } from "./writer.js";
