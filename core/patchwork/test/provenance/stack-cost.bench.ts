// What the provenance stamp pays per change to read a stack: the budget is 20 µs.
import { bench, describe } from "vitest";

function nest(depth: number, read: () => string | undefined): string | undefined {
  return depth === 0 ? read() : nest(depth - 1, read);
}

const raised = () => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
};

const plain = () => new Error().stack;

describe("reading new Error().stack 30 frames deep", () => {
  bench("stackTraceLimit 50", () => {
    nest(30, raised);
  });
  bench("default stackTraceLimit", () => {
    nest(30, plain);
  });
});
