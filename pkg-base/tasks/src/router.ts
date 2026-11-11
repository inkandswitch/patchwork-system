/* eslint-env worker */

import type { TaskQueueDoc, RouterDoc, WorkerDoc, TaskQueueSet } from './datatype';
import type {
  MessageToRouter,
  MessageToRouterChannel,
  MessageToTaskQueueChannel,
  MessageToWorkerChannel,
} from './protocol';
import type {
  AutomergeUrl,
  DocHandle,
  DocHandleEphemeralMessagePayload,
  Repo,
} from '@automerge/automerge-repo/slim';

import { connectRepoPort, getRepo, setUpImportMap } from './webworker-lib';
import generateName from 'boring-name-generator';
import { seconds, shuffle } from './helpers';

let repo: Repo;
let contactUrl: AutomergeUrl;
let thisRouterHandle: DocHandle<RouterDoc>;

const taskQueueHandles = new Map<AutomergeUrl, DocHandle<TaskQueueDoc>>();
const lastTimestampFromRouter = new Map<AutomergeUrl, number>();
const attemptingToTakeOverTaskQueueUrls = new Set<AutomergeUrl>();

interface WorkerState {
  handle: DocHandle<WorkerDoc>;
  /** Last task URL reported by the worker pool heartbeat (replica of WorkerDoc). */
  currentTaskUrl: AutomergeUrl | null;
  /** Task URL this router assigned via broadcast but the worker doc may not reflect yet. */
  claimedTaskUrl: AutomergeUrl | null;
  /** When {@link claimedTaskUrl} was set; used to drop stuck claims if replicas miss the busy state. */
  claimIssuedAt: number;
  taskQueues: TaskQueueSet;
  lastTimestamp: number;
}

const workers = new Map<AutomergeUrl, WorkerState>();

self.addEventListener('connect', (e: any) => {
  console.log('got a connection!');
  const port = e.ports[0];
  port.onmessage = (e: any) => {
    const msg: MessageToRouter = e.data;
    console.log('received message', e.data);
    try {
      switch (msg.type) {
        case 'init':
          init(msg.repoPort, msg.contactUrl, msg.importMap, msg.baseURI);
          break;
        case 'update task queue set':
          updateTaskQueueSet(msg.taskQueues);
          break;
        case 'terminate':
          self.close();
          break;
      }
    } catch (error) {
      console.error('uh-oh, error handling message', { msg, error });
    }
  };
});

const { promise: repoPromise, resolve: repoResolve } = Promise.withResolvers();

async function init(
  repoPort: MessagePort,
  _contactUrl: AutomergeUrl,
  importMap: any,
  baseURI: string,
) {
  if (repo) {
    await connectRepoPort(repo, repoPort);
  }

  if (contactUrl && repo && thisRouterHandle) {
    console.log('already initialized');
    return;
  }

  console.log('initializing');

  contactUrl = _contactUrl;

  if (!repo) {
    await setUpImportMap(importMap, baseURI);
    repo = await getRepo(repoPort, `task-router-${Math.round(Math.random() * 1_000_000)}`);
    repoResolve(repo);
  }

  thisRouterHandle = repo.create<RouterDoc>({ name: generateName().dashed, contactUrl });
  thisRouterHandle.on('ephemeral-message', (payload) => {
    console.log('received ephemeral message directed at me (as the active router)');
    const msg: MessageToRouterChannel = payload.message as any;
    switch (msg.type) {
      case 'worker heartbeat':
        processWorkerHeartbeat(msg.workerUrl, msg.currentTask?.taskUrl ?? null, msg.taskQueues);
        break;
    }
  });

  pRouteTasks();
  pSendHeartbeats();
  pDropStaleWorkerInfos();
  pTakeOverFromInactiveRouters();

  console.log('ready!', thisRouterHandle.url);
  console.log('hola, me llamo', thisRouterHandle.doc().name);
}

async function pRouteTasks() {
  while (true) {
    releaseRouterClaimsAckedByWorkerDoc();
    const idleWorkersByTaskQueueUrl = getIdleWorkersByTaskQueueUrl();
    const taskQueuesWithPendingTasks = shuffle(
      [...taskQueueHandles.values()]
        .filter(thisIsTheActiveRouterFor)
        .filter((taskQueue) => taskQueue.doc().pending.length > 0),
    );
    while (taskQueuesWithPendingTasks.length > 0) {
      const taskQueue = taskQueuesWithPendingTasks.shift()!;
      const nextPendingTaskUrl = nextPendingTask(taskQueue);
      if (!nextPendingTaskUrl) {
        continue;
      }

      const idleWorkers = idleWorkersByTaskQueueUrl.get(taskQueue.url);
      if (!idleWorkers || idleWorkers.size === 0) {
        continue;
      }

      const worker = shuffle([...idleWorkers])[0];
      worker.claimedTaskUrl = nextPendingTaskUrl;
      worker.claimIssuedAt = Date.now();
      console.log('routing task', nextPendingTaskUrl, 'to worker', worker.handle.url);
      worker.handle.broadcast({
        type: 'work on',
        taskUrl: nextPendingTaskUrl,
        taskQueueUrl: taskQueue.url,
      } satisfies MessageToWorkerChannel);

      // remove this worker from all idle workers sets
      for (const idleWorkers of idleWorkersByTaskQueueUrl.values()) {
        idleWorkers.delete(worker);
      }

      // this task queue may have more pending tasks, so we add it back to the list
      taskQueuesWithPendingTasks.push(taskQueue);
    }

    await seconds(1);
  }
}

async function pSendHeartbeats() {
  while (true) {
    for (const taskQueueHandle of taskQueueHandles.values()) {
      if (thisIsTheActiveRouterFor(taskQueueHandle)) {
        console.log('sending router heartbeat');
        taskQueueHandle.broadcast({
          type: 'router heartbeat',
          routerUrl: thisRouterHandle.url,
          workerUrls: [...workers.values()]
            .filter((worker) => shouldIncludeInHeartbeat(worker, taskQueueHandle.url))
            .map((worker) => worker.handle.url),
        } satisfies MessageToTaskQueueChannel);
      }
    }
    await seconds(1);
  }

  // helpers

  function shouldIncludeInHeartbeat(worker: WorkerState, taskQueueUrl: AutomergeUrl) {
    if (!worker.taskQueues[taskQueueUrl]) {
      return false;
    }

    const { currentTask } = worker.handle.doc();
    return !currentTask || currentTask.taskQueueUrl === taskQueueUrl;
  }
}

async function pDropStaleWorkerInfos() {
  while (true) {
    for (const { handle, lastTimestamp: timestamp } of workers.values()) {
      if (Date.now() - timestamp! > 10 * 1_000) {
        workers.delete(handle.url);
      }
    }
    await seconds(0.5);
  }
}

async function pTakeOverFromInactiveRouters() {
  while (true) {
    for (const taskQueueHandle of taskQueueHandles.values()) {
      const activeRouterUrl = taskQueueHandle.doc().activeRouter;
      if (
        activeRouterUrl === thisRouterHandle.url ||
        attemptingToTakeOverTaskQueueUrls.has(taskQueueHandle.url)
      ) {
        continue;
      }

      const lastTimestamp =
        activeRouterUrl && lastTimestampFromRouter.has(activeRouterUrl)
          ? lastTimestampFromRouter.get(activeRouterUrl)!
          : 0;
      if (lastTimestamp < Date.now() - 10 * 1_000) {
        attemptToTakeOver(taskQueueHandle);
      }
    }
    await seconds(1);
  }
}

function attemptToTakeOver(taskQueueHandle: DocHandle<TaskQueueDoc>) {
  console.log('attempting takeover of', taskQueueHandle.url);
  attemptingToTakeOverTaskQueueUrls.add(taskQueueHandle.url);
  taskQueueHandle.change((doc) => {
    doc.activeRouter = thisRouterHandle.url;
  });

  (async () => {
    // this wait is important!
    // - it enables this router to gather info from workers (who's around, who's working on what)
    // - it also gives the change to the task queue doc (to set the active router) a chance to propagate
    await seconds(3);

    if (thisIsTheActiveRouterFor(taskQueueHandle)) {
      console.log('I am now the router for this task queue!');
    }

    attemptingToTakeOverTaskQueueUrls.delete(taskQueueHandle.url);
  })();
}

// helpers

/** Drop router-side claims once we know the worker took the task, or recover from missed replicas. */
function releaseRouterClaimsAckedByWorkerDoc() {
  const now = Date.now();
  for (const worker of workers.values()) {
    const claimed = worker.claimedTaskUrl;
    if (!claimed) {
      continue;
    }

    const docTask = worker.handle.doc().currentTask?.taskUrl;
    if (docTask === claimed) {
      worker.claimedTaskUrl = null;
      continue;
    }

    // Pool heartbeat saw this worker busy with our claim — safe to drop claim; busy is tracked via currentTaskUrl.
    if (worker.currentTaskUrl === claimed) {
      worker.claimedTaskUrl = null;
      continue;
    }

    // Fast tasks can finish between heartbeats so we never observe currentTask === claimed on this replica.
    const idleOnRouter = !docTask && !worker.currentTaskUrl;
    if (idleOnRouter && now - worker.claimIssuedAt > 4_000) {
      worker.claimedTaskUrl = null;
    }
  }
}

function getIdleWorkersByTaskQueueUrl() {
  const idleWorkers = [...workers.values()].filter((worker) => {
    const docBusy = !!worker.handle.doc().currentTask;
    const heartbeatBusy = !!worker.currentTaskUrl;
    return !docBusy && !heartbeatBusy && !worker.claimedTaskUrl;
  });
  const idleWorkersByTaskQueueUrl = new Map<AutomergeUrl, Set<WorkerState>>();
  for (const worker of idleWorkers) {
    for (const taskQueueUrl of Object.keys(worker.taskQueues) as AutomergeUrl[]) {
      if (!idleWorkersByTaskQueueUrl.has(taskQueueUrl)) {
        idleWorkersByTaskQueueUrl.set(taskQueueUrl, new Set<WorkerState>());
      }
      idleWorkersByTaskQueueUrl.get(taskQueueUrl)!.add(worker);
    }
  }
  return idleWorkersByTaskQueueUrl;
}

function nextPendingTask(taskQueueHandle: DocHandle<TaskQueueDoc>) {
  for (const taskUrl of taskQueueHandle.doc().pending) {
    if (isReallyPending(taskUrl)) {
      return taskUrl;
    }
  }
  return null;
}

function isReallyPending(taskUrl: AutomergeUrl) {
  for (const worker of workers.values()) {
    const docTask = worker.handle.doc().currentTask?.taskUrl;
    if (
      taskUrl === docTask ||
      taskUrl === worker.claimedTaskUrl ||
      taskUrl === worker.currentTaskUrl
    ) {
      return false;
    }
  }
  return true;
}

async function updateTaskQueueSet(taskQueues: TaskQueueSet) {
  // remove task queues that are no longer in the set
  for (const taskQueueUrl of taskQueueHandles.keys()) {
    if (!Object.keys(taskQueues).includes(taskQueueUrl)) {
      leaveTaskQueue(taskQueueUrl);
    }
  }

  // add task queues that are new
  for (const taskQueueUrl of Object.keys(taskQueues)) {
    if (!taskQueueHandles.has(taskQueueUrl as AutomergeUrl)) {
      joinTaskQueue(taskQueueUrl as AutomergeUrl);
    }
  }
}

async function joinTaskQueue(taskQueueUrl: AutomergeUrl) {
  let handle: DocHandle<TaskQueueDoc>;
  try {
    await repoPromise;
    handle = await repo.find<TaskQueueDoc>(taskQueueUrl);
  } catch (error) {
    console.error('unable to get doc handle for task queue', { taskQueueUrl, error });
    return;
  }

  taskQueueHandles.set(taskQueueUrl, handle);
  handle.on('ephemeral-message', handleEphemeralMessages);
}

async function leaveTaskQueue(taskQueueUrl: AutomergeUrl) {
  const handle = taskQueueHandles.get(taskQueueUrl);
  handle?.off('ephemeral-message', handleEphemeralMessages);
  taskQueueHandles.delete(taskQueueUrl);
}

function handleEphemeralMessages(payload: DocHandleEphemeralMessagePayload<TaskQueueDoc>) {
  const msg: MessageToTaskQueueChannel = payload.message as any;
  console.log('received ephemeral message (directed at task queue)', msg);
  switch (msg.type) {
    case 'router heartbeat':
      processRouterHeartbeat(msg.routerUrl);
      break;
  }
}

function processRouterHeartbeat(routerUrl: AutomergeUrl) {
  lastTimestampFromRouter.set(routerUrl, Date.now());
}

async function processWorkerHeartbeat(
  workerUrl: AutomergeUrl,
  currentTaskUrl: AutomergeUrl | null,
  taskQueues: TaskQueueSet,
) {
  const lastTimestamp = Date.now();
  const state = workers.get(workerUrl);
  if (state) {
    state.currentTaskUrl = currentTaskUrl;
    state.taskQueues = taskQueues;
    state.lastTimestamp = lastTimestamp;
    // Heartbeat proves the pool saw the worker pick up this assignment; router doc can still lag.
    if (state.claimedTaskUrl && currentTaskUrl === state.claimedTaskUrl) {
      state.claimedTaskUrl = null;
    }
  } else {
    try {
      await repoPromise;
      workers.set(workerUrl, {
        handle: await repo.find(workerUrl),
        currentTaskUrl,
        claimedTaskUrl: null,
        claimIssuedAt: 0,
        taskQueues,
        lastTimestamp,
      });
    } catch (error) {
      console.error('unable to get doc handle for worker', { workerUrl, error });
    }
  }
}

function thisIsTheActiveRouterFor(taskQueueHandle: DocHandle<TaskQueueDoc>) {
  return (
    taskQueueHandle.doc().activeRouter === thisRouterHandle?.url &&
    !attemptingToTakeOverTaskQueueUrls.has(taskQueueHandle.url)
  );
}

export { }; // to ensure this is a module
