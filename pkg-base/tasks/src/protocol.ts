import type { AutomergeUrl } from '@automerge/automerge-repo/slim';
import { TaskQueueSet } from './datatype';

export type MessageToWorkerPoolProxy =
  // sent by workers
  | RegisterWorkerMessage
  ;

export type MessageToWorkerPool =
  // sent by the app (worker pool proxy)
  | InitMessage
  | RegisterWorkerMessage // forwarded by the worker pool proxy when received from a worker
  | UpdateTaskQueueSetMessage
  | TerminateMessage
  ;

export type MessageToRouter =
  // sent by the app (worker pool proxy)
  | InitMessage
  | UpdateTaskQueueSetMessage
  | TerminateMessage
  ;

export type MessageToRouterChannel =
  // sent by worker pools (one per worker) to the active router of each task queue
  | WorkerHeartbeatMessage
  ;

export type MessageToTaskQueueChannel =
  // sent by the active router
  | RouterHeartbeatMessage
  ;

export type MessageToWorker =
  // sent by the app (worker pool proxy)
  | WorkerInitMessage
  | TerminateMessage
  ;

export type MessageToWorkerChannel =
  // sent by an active router
  | WorkOnTaskMessage
  ;

export interface InitMessage {
  type: 'init';
  repoPort: MessagePort;
  contactUrl: AutomergeUrl;
  importMap: any;
  baseURI: string;
}

export interface WorkerInitMessage extends InitMessage {}

export interface RegisterWorkerMessage {
  type: 'register worker';
  sharedWorkerName: string;
  workerUrl: AutomergeUrl;
}

export interface UpdateTaskQueueSetMessage {
  type: 'update task queue set';
  taskQueues: TaskQueueSet;
}

export interface TerminateMessage {
  type: 'terminate';
}

export interface WorkerHeartbeatMessage {
  type: 'worker heartbeat';
  workerUrl: AutomergeUrl;
  currentTask: { taskUrl: AutomergeUrl; taskQueueUrl: AutomergeUrl } | null;
  taskQueues: TaskQueueSet;
}

export interface RouterHeartbeatMessage {
  type: 'router heartbeat';
  routerUrl: AutomergeUrl;
  workerUrls: AutomergeUrl[];
};

export interface WorkOnTaskMessage {
  type: 'work on';
  taskUrl: AutomergeUrl;
  taskQueueUrl: AutomergeUrl;
}