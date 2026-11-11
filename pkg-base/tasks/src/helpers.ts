import { type AutomergeUrl, type DocHandle, type Repo } from '@automerge/automerge-repo/slim';
import { TaskQueueSet } from './datatype';

export const TASK_QUEUE_URLS_FIELD_NAME = '__taskQueues__';

// TODO: where's the type for account??
export async function getAccountHandle(repo: Repo): Promise<DocHandle<any>> {
  const accountDocUrl = getAccountDocUrl();
  // avoid importing isValidAutomergeUrl for BS packaging reasons
  if (!accountDocUrl.startsWith('automerge:')) {
    const errorMsg = `account doc url invalid: ${accountDocUrl}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }
  const accountHandle = await repo.find<any>(accountDocUrl);
  if (!accountHandle) {
    const errorMsg = `no doc at account doc url: ${accountDocUrl}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }
  return accountHandle;
}

// TODO: what's the right way to get this??
export function getAccountDocUrl(): AutomergeUrl {
  return localStorage.getItem('tinyPatchworkAccountUrl') as AutomergeUrl;
}

export async function getSelfContactUrl(repo: Repo): Promise<AutomergeUrl> {
  const accountHandle = await getAccountHandle(repo);
  return accountHandle.doc().contactUrl;
}

export type TaskQueues = { [taskQueueUrl: AutomergeUrl]: true };

export function getTaskQueues(account: any): TaskQueues {
  return account[TASK_QUEUE_URLS_FIELD_NAME] ?? { 'automerge:2xrHArq3QwSGHaeUdquP7ECTpnEL': true };
}

export function addTaskQueue(account: any, taskQueueUrl: AutomergeUrl) {
  let taskQueues: TaskQueueSet | null = account[TASK_QUEUE_URLS_FIELD_NAME];
  if (!taskQueues) {
    taskQueues = account[TASK_QUEUE_URLS_FIELD_NAME] = {};
  }
  taskQueues![taskQueueUrl] = true;
}

export const seconds = async (s: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, s * 1_000);
  });

export function notNull<T>(value: T | null): value is T {
  return value !== null;
}

export function shuffle<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    // Pick a random index from 0 to i
    const j = Math.floor(Math.random() * (i + 1));
    // Swap elements array[i] and array[j]
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
