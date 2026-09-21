// One node for every tab on the origin, in a SharedWorker: lives as long as
// any tab does.
import { startNode } from "./node.js";
import type { ControlPort } from "./protocol.js";

const node = startNode();
(self as unknown as { onconnect: (event: MessageEvent) => void }).onconnect = (
  event
) => node.attach(event.ports[0]);
