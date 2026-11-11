/* eslint-env worker */

import type { AutomergeUrl, DocHandle, Repo } from '@automerge/automerge-repo/slim';
import type { WorkerDoc, RouterDoc, TaskQueueDoc, TaskQueueSet } from './datatype';
import type { MessageToWorkerPool, MessageToRouterChannel } from './protocol';

import { connectRepoPort, getRepo, setUpImportMap } from './webworker-lib';
import { seconds } from './helpers';

interface TaskQueueState {
  activeRouterHandle: DocHandle<RouterDoc> | null;
}

let repo: Repo;

let status: 'not initialized' | 'initializing' | 'ready' = 'not initialized';
const toDoAfterInit: (() => Promise<void>)[] = [];

const sharedWorkerNames = new Set<string>();
const workerByUrl = new Map<AutomergeUrl, WorkerDoc>();

const taskQueueUrls = new Set<AutomergeUrl>();
const taskQueueState = new Map<AutomergeUrl, TaskQueueState>();

console.log('hi there, I am the worker pool!');

self.addEventListener('connect', (e: any) => {
  console.log('got a connection!');
  const port = e.ports[0];
  port.onmessage = (e: any) => {
    const msg: MessageToWorkerPool = e.data;
    console.log('received message', msg);
    try {
      switch (msg.type) {
        case 'init':
          init(msg.repoPort, msg.importMap, msg.baseURI);
          break;
        case 'update task queue set':
          updateTaskQueueSet(msg.taskQueues);
          break;
        case 'register worker':
          registerWorker(msg.sharedWorkerName, msg.workerUrl);
          break;
      }
    } catch (error) {
      console.error('uh-oh, error handling message in worker pool', { msg, error });
    }
  };
});

async function init(port: MessagePort, importMap: any, baseURI: string) {
  if (status !== 'not initialized') {
    if (repo) {
      await connectRepoPort(repo, port);
    }
    return;
  }

  console.log('initializing...');
  status = 'initializing';

  await setUpImportMap(importMap, baseURI);
  repo = await getRepo(port, `task-worker-pool-${Math.round(Math.random() * 10_000)}`);
  pSendWorkerStatuses(); // this is a "process", meant to be running in the background (hence no `await`)

  console.log('ready');
  status = 'ready';

  while (toDoAfterInit.length > 0) {
    await toDoAfterInit.shift()!();
  }
}

async function updateTaskQueueSet(newTaskQueueUrls: TaskQueueSet) {
  if (status !== 'ready') {
    // haven't initialized yet, so save this for later
    toDoAfterInit.push(() => updateTaskQueueSet(newTaskQueueUrls));
    return;
  }

  // remove task queues that are no longer in the set
  for (const taskQueueUrl of taskQueueUrls) {
    if (!newTaskQueueUrls[taskQueueUrl]) {
      taskQueueUrls.delete(taskQueueUrl);
      taskQueueState.delete(taskQueueUrl);
    }
  }

  // add the new ones
  for (const taskQueueUrl of Object.keys(newTaskQueueUrls) as AutomergeUrl[]) {
    if (taskQueueUrls.has(taskQueueUrl)) {
      continue;
    }

    console.log('joining task queue', taskQueueUrl);

    let taskQueueHandle: DocHandle<TaskQueueDoc>;
    try {
      taskQueueHandle = await repo.find<TaskQueueDoc>(taskQueueUrl);
    } catch (error) {
      console.error('did not join task queue, unable to get its doc handle', {
        taskQueueUrl,
        error,
      });
      return;
    }

    taskQueueUrls.add(taskQueueUrl);
    taskQueueState.set(taskQueueUrl, { activeRouterHandle: null });

    async function setTaskQueueState(taskQueue: TaskQueueDoc) {
      try {
        const activeRouterHandle = taskQueue.activeRouter
          ? await repo.find<RouterDoc>(taskQueue.activeRouter)
          : null;
        taskQueueState.set(taskQueueUrl, { activeRouterHandle });
      } catch (error) {
        console.error('error finding doc for active router', { taskQueueUrl, error });
      }
    }

    taskQueueHandle.on('change', (payload) => setTaskQueueState(payload.doc));
    await setTaskQueueState(taskQueueHandle.doc());

    console.log('done joining task queue', taskQueueUrl);
  }
}

async function registerWorker(sharedWorkerName: string, workerUrl: AutomergeUrl) {
  if (sharedWorkerNames.has(sharedWorkerName)) {
    // already added!
    console.log('registerWorker: already know about', sharedWorkerName);
    return;
  } else if (status !== 'ready') {
    // haven't initialized yet, so save this for later
    console.log('registerWorker: will register', sharedWorkerName, 'after init');
    toDoAfterInit.push(() => registerWorker(sharedWorkerName, workerUrl));
    return;
  }

  console.log('adding worker', { sharedWorkerName, workerUrl });

  sharedWorkerNames.add(sharedWorkerName);

  try {
    const workerHandle = await repo.find<WorkerDoc>(workerUrl);
    workerHandle.on('change', (payload) => workerByUrl.set(workerUrl, payload.doc));
    workerByUrl.set(workerUrl, workerHandle.doc());
  } catch (error) {
    console.error('did not add worker, unable to get its doc handle', { workerUrl, error });
    sharedWorkerNames.delete(sharedWorkerName);
  }
}

async function pSendWorkerStatuses() {
  while (true) {
    await seconds(1);

    const taskQueues: TaskQueueSet = {};
    for (const taskQueueUrl of taskQueueUrls) {
      taskQueues[taskQueueUrl] = true;
    }

    for (const [taskQueueUrl, { activeRouterHandle }] of taskQueueState.entries()) {
      if (!activeRouterHandle) {
        continue;
      }

      for (const [workerUrl, { currentTask }] of workerByUrl.entries()) {
        if (currentTask && currentTask.taskQueueUrl !== taskQueueUrl) {
          // don't bother sending the heartbeats of workers that are busy with tasks from other queues
        } else {
          console.log('sending worker heartbeat to', activeRouterHandle.url, { workerUrl, currentTask });
          activeRouterHandle.broadcast({
            type: 'worker heartbeat',
            workerUrl,
            currentTask,
            taskQueues,
          } satisfies MessageToRouterChannel);
        }
      }
    }
  }
}

export { }; // to ensure this is a module
