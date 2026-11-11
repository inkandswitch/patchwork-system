import type { AutomergeUrl } from '@automerge/automerge-repo/slim';
import type { DatatypeImplementation } from '@inkandswitch/patchwork-plugins';

// Task Queue

export interface TaskQueueDoc {
  title?: string;
  activeRouter: AutomergeUrl | null;
  pending: AutomergeUrl[];
  done: AutomergeUrl[];
  doneSet: { [key: AutomergeUrl]: true };
}

export const TaskQueueDatatype: DatatypeImplementation<TaskQueueDoc> = {
  init(doc: TaskQueueDoc) {
    doc.activeRouter = null;
    doc.pending = [];
    doc.done = [];
    doc.doneSet = {};
  },
  getTitle(doc: TaskQueueDoc) {
    return doc.title ?? 'Task Queue';
  },
  setTitle(doc: TaskQueueDoc, title: string) {
    doc.title = title;
  },
};

// Task

export interface TaskDoc<Input, Result> {
  title?: string;
  input: Input;
  importUrl: string;
  runs: RunInfo<Result>[];
}

export interface RunInfo<Result> {
  workerUrl: AutomergeUrl;
  status: RunStatus;
  result?: Result; // only if status === 'succeeded'
  logs?: RunLogEntry[];
  startTimeMillis: number;
  endTimeMillis: number;
}

export type RunStatus = 'succeeded' | 'failed';

export interface RunLogEntry {
  timestampMillis: number;
  message: string;
}

export const taskDatatype: DatatypeImplementation<TaskDoc<any, any>> = {
  init(doc: TaskDoc<any, any>) {
    doc.input = null;
    doc.importUrl = '';
    doc.runs = [];
  },
  getTitle(doc: TaskDoc<any, any>) {
    return doc.title ?? '';
  },
  setTitle(doc: TaskDoc<any, any>, title: string) {
    doc.title = title;
  },
};

// Worker

export interface WorkerDoc {
  name: string;
  contactUrl: AutomergeUrl;
  currentTask: { taskUrl: AutomergeUrl; taskQueueUrl: AutomergeUrl } | null;
}

// Router

export interface RouterDoc {
  name: string;
  contactUrl: AutomergeUrl;
}

export type TaskQueueSet = Record<AutomergeUrl, true>;
