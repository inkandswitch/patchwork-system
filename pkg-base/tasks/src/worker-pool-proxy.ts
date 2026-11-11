import type { AutomergeUrl } from '@automerge/automerge-repo/slim';
import type { MessageToRouter, MessageToWorker, MessageToWorkerPool } from './protocol';

import { getAccountHandle, getTaskQueues } from './helpers';

import WorkerPool from './worker-pool.ts?sharedworker';
import TaskWorker from './worker.ts?sharedworker';
import TaskRouter from './router.ts?sharedworker';

const NUM_WORKERS = 2;

export class WorkerPoolProxy {
  private readonly workerPool: SharedWorker;
  private readonly workers: SharedWorker[] = [];
  private readonly router: SharedWorker;

  constructor(
    readonly contactUrl: AutomergeUrl,
    importMap: any,
    baseURI: string,
  ) {
    this.workerPool = this.createAndInitializeWorkerPool(importMap, baseURI);

    for (let workerId = 0; workerId < NUM_WORKERS; workerId++) {
      this.workers.push(this.createAndInitializeWorker(workerId, importMap, baseURI));
    }

    this.router = this.createAndInitializeRouter(importMap, baseURI);
  }

  private createAndInitializeWorkerPool(importMap: any, baseURI: string) {
    // create the shared worker
    const workerPool = new WorkerPool({ name: `task-worker-pool` });
    workerPool.onerror = (error) => log(error);

    this.subscribeToRepoChannel('worker pool', (repoPort) => {
      log('sending init to worker pool');
      workerPool.port.postMessage(
        {
          type: 'init',
          contactUrl: this.contactUrl,
          repoPort,
          importMap,
          baseURI,
        } satisfies MessageToWorkerPool,
        [repoPort],
      );
    });

    return workerPool;
  }

  private createAndInitializeWorker(id: number, importMap: any, baseURI: string) {
    // create the shared worker
    const name = `task-worker-${id}`;
    log('creating and initializing worker', name);
    const worker = new TaskWorker({ name });
    worker.onerror = (error) => log(`worker ${id} error:`, error);

    // forward messages from the worker (type 'add worker') to the worker pool
    worker.port.onmessage = (e: any) => {
      log('received message from worker that i will forward to the pool', e.data);
      this.workerPool.port.postMessage(e.data);
    };

    worker.port.onmessageerror = (e) => {
      log('message error from worker', name, e);
    };

    (worker.port as any).start?.();

    this.subscribeToRepoChannel(name, (repoPort) => {
      log('sending init message to', name);
      worker.port.postMessage(
        {
          type: 'init',
          repoPort,
          contactUrl: this.contactUrl,
          importMap,
          baseURI,
        } satisfies MessageToWorker,
        [repoPort],
      );
    });

    return worker;
  }

  private createAndInitializeRouter(importMap: any, baseURI: string) {
    // create the shared worker
    const router = new TaskRouter({ name: `task-router` });
    router.onerror = (error) => log(error);

    this.subscribeToRepoChannel('router', (repoPort) => {
      log('sending init message to router');
      router.port.postMessage(
        {
          type: 'init',
          repoPort,
          contactUrl: this.contactUrl,
          importMap,
          baseURI,
        } satisfies MessageToRouter,
        [repoPort],
      );
    });

    // note: no `await` on purpose
    this.setUpTaskQueueSetUpdates();

    return router;
  }

  async setUpTaskQueueSetUpdates() {
    const updateTaskQueues = (accountDoc: any) => {
      const message: MessageToWorkerPool = {
        type: 'update task queue set',
        taskQueues: getTaskQueues(accountDoc),
      };
      // Router needs the set so it can join queues, run takeover, and broadcast UI heartbeats.
      this.sendToRouter(message);
      // Worker pool must get the same update: it forwards worker heartbeats to the active
      // router's doc channel; without this it never joins queues and the router sees no workers.
      this.workerPool.port.postMessage(message);
    };

    const accountHandle = await getAccountHandle(repo);
    accountHandle.on('change', (payload) => updateTaskQueues(payload.handle.doc()));
    updateTaskQueues(accountHandle.doc());
  }

  sendToRouter(message: MessageToRouter) {
    this.router.port.postMessage(message);
  }

  private subscribeToRepoChannel(
    label: string,
    listener: (repoPort: MessagePort) => void,
  ) {
    void getPatchworkSw().subscribeToRepoChannel(async (repoPort) => {
      listener(repoPort);
    }).catch((error) => {
      console.error(`failed to subscribe ${label} to repo channel`, error);
    });
  }
}

function getPatchworkSw() {
  const sw = (window as any).patchwork?.sw;
  if (!sw?.subscribeToRepoChannel) {
    throw new Error('patchwork service worker repo channel API is unavailable');
  }
  return sw as {
    subscribeToRepoChannel: (
      listener: (repoPort: MessagePort) => void | Promise<void>,
    ) => Promise<() => void>;
  };
}

function log(...args: any) {
  console.log('worker pool proxy:', ...args);
}
