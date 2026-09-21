// One node per tab, in a dedicated Worker: dies with its tab.
import { startNode } from "./node.js";
import type { ControlPort } from "./protocol.js";

startNode().attach(self as unknown as ControlPort);
