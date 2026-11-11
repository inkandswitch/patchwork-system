import { Repo } from '@automerge/automerge-repo';
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';
import Worker from 'web-worker';

async function start(taskQueueUrl) {
  const repo = new Repo({
    network: [new WebSocketClientAdapter('wss://sync3.automerge.org')],
    peerId: `google-cloud-${Math.round(Math.random() * 10_000)}`,
  });

  const taskQueueHandle = await repo.find(taskQueueUrl);
  console.log('taskQueue', taskQueueHandle.doc());
  const workers = startWorkers(taskQueueHandle, '2FBG97KHy7iNrsKMtoaYzLsYCBXN', 5);
}

function startWorkers(queueHandle, contactUrl, numWorkers) {
  const workers = [];
  for (let i = 0; i < numWorkers; i++) {
    // Create and initialize autonomous worker
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
    worker.postMessage({
      queueUrl: queueHandle.url,
      contactUrl: contactUrl,
    });
    workers.push(worker);
  }
  return workers;
}

start(process.argv[2]);

