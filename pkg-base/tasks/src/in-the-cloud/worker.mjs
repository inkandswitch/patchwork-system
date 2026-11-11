/* eslint-env worker */

//import { automergeWasmBase64 } from '@automerge/automerge/automerge.wasm.base64';
//import { Repo, initializeBase64Wasm } from '@automerge/automerge-repo/slim';
import { Repo } from '@automerge/automerge-repo';
import generateName from 'boring-name-generator';
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';

let repo = null;
let queueHandle = null;
let activeRouterHandle = null;
let workerHandle = null;
let currentTaskUrl = null;

// Worker initialization
self.onmessage = async (event) => {
  if (!(event.data.queueUrl)) {
    return;
  }

  const { queueUrl, contactUrl } = event.data;

	console.log('worker received message', event.data);

  try {
    // await initializeBase64Wasm(automergeWasmBase64);

    // Create repo with MessageChannel network adapter
    repo = new Repo({
      network: [new WebSocketClientAdapter('wss://sync3.automerge.org')],
      peerId: `worker-${Math.round(Math.random() * 10_000)}`,
    });
    self.repo = repo;

    // Find the queue document
    queueHandle = await repo.find(queueUrl);
    queueHandle.on('change', (payload) => updateActiveRouter(payload.doc));
    updateActiveRouter(queueHandle.doc());

    // Create our own worker document for announcement
    workerHandle = repo.create({
      name: 'cloud-' + generateName().dashed,
      contactUrl: contactUrl ?? null,
      currentTask: null,
    });
    workerHandle.on('ephemeral-message', (payload) => processMessageFromRouter(payload.message));

    pHeartbeat();

    console.log('worker: Ready and running autonomously', {
      queueUrl,
      workerUrl: workerHandle.url,
    });
  } catch (error) {
    console.error('worker: Failed to initialize:', error);
  }
};

async function pHeartbeat() {
  while (true) {
    await seconds(1);

    if (activeRouterHandle == null) {
      // console.log('worker: not sending heartbeat b/c no active router!');
      continue;
    }

    const status = {
      worker: workerHandle.url,
      currentTask: currentTaskUrl,
    };
    // console.log('worker: sending heartbeat to', activeRouterHandle.url, status);
    activeRouterHandle.broadcast(status);
  }
}

async function updateActiveRouter(taskQueue) {
  if (
    (taskQueue.router == null && activeRouterHandle == null) ||
    taskQueue.router === activeRouterHandle?.url
  ) {
    return;
  }

  // console.log('worker: active router is now', taskQueue.router);

  activeRouterHandle?.off('ephemeral-message');

  if (taskQueue.router == null) {
    activeRouterHandle = null;
  } else {
    activeRouterHandle = await repo.find(taskQueue.router);
  }
}

async function processMessageFromRouter(m) {
  // console.log('worker: received message from router', m);
  switch (m.type) {
    case 'work on': {
      if (currentTaskUrl == null) {
        processTask(m.task);
      }
      break;
    }
  }
}

async function processTask(taskUrl) {
  currentTaskUrl = taskUrl;
  try {
    await executeTask();
    moveTaskToDone();
  } catch (error) {
    console.error('worker: error while processing task:', error);
  } finally {
    currentTaskUrl = null;
  }
}

// Move completed task to done queue
function moveTaskToDone() {
  queueHandle.change((doc) => {
    const idx = doc.pending.indexOf(currentTaskUrl);
    doc.pending.splice(idx, 1);
    doc.done.push(currentTaskUrl);
  });
}

async function executeTask() {
  // Update worker status to show current task
  workerHandle.change((doc) => {
    doc.currentTask = currentTaskUrl;
  });

  const currentTaskHandle = await repo.find(currentTaskUrl);
  const taskDoc = currentTaskHandle.doc();
  if (!taskDoc) {
    console.error('worker: Task document not found:', currentTaskUrl);
    return;
  }

  console.log('worker: Executing task:', currentTaskUrl);

  const input = taskDoc.input;
  const log = [];
  let status = 'succeeded';
  let result = null;
  const startTime = Date.now();

  try {
    // Dynamic import of the task module
    const module = await import(taskDoc.importUrl);
    const taskFunction = module.default;

    // Execute the task with logging context
    result = await taskFunction.call(
      {
        log(...args) {
          const timestamp = Date.now();
          const message = args.map((arg) => '' + arg).reduce((acc, m) => `${acc} ${m}`);
          log.push([timestamp, message]);
          console.log('Task log:', message);
        },
      },
      input
    );
  } catch (error) {
    console.error('Worker: Task execution failed:', error);
    log.push([Date.now(), error?.message ?? '' + error]);
    status = 'failed';
  }

  const endTime = Date.now();

  // Update task document with results
  currentTaskHandle.change((doc) => {
    doc.runs.push({
      worker: workerHandle.documentId,
      status,
      result,
      startTime,
      endTime,
      log,
    });
  });

  // Clear current task from worker
  workerHandle.change((doc) => {
    doc.currentTask = null;
  });
}

const seconds = async (s) =>
  new Promise((resolve) => {
    setTimeout(resolve, s * 1_000);
  });

