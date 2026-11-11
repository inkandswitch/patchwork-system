import React, { Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import type { AutomergeUrl, DocHandle } from '@automerge/automerge-repo/slim';
import { RepoContext, useDocument } from '@automerge/automerge-repo-react-hooks';
import type { OpenDocumentEventDetail } from '@inkandswitch/patchwork-elements';
import type { TaskQueueDoc } from './datatype';
import { WorkerPoolProxy } from './worker-pool-proxy';
import { getAccountDocUrl, getTaskQueues } from './helpers';

export const TitlebarTool = (handle: DocHandle<unknown>, element: HTMLElement) => {
  const repo = (element as any).repo;
  const root = createRoot(element);
  root.render(
    <RepoContext.Provider value={repo}>
      <Suspense fallback={null}>
        <ITitlebarTool element={element} />
      </Suspense>
    </RepoContext.Provider>,
  );
  return () => root.unmount();
};

const ITitlebarTool: React.FC<{ element: HTMLElement }> = ({ element }) => {
  const [accountDoc] = useDocument<any>(getAccountDocUrl(), { suspense: true });
  const selfContactUrl: AutomergeUrl = accountDoc.contactUrl;
  const taskQueueUrls = getTaskQueues(accountDoc);

  const [, setWorkerPool] = useState<WorkerPoolProxy | null>(null);
  useEffect(() => {
    const proxy = new WorkerPoolProxy(selfContactUrl, getImportMap(), document.baseURI);
    console.log('titlebar-tool created worker pool proxy', proxy);
    setWorkerPool(proxy);
  }, [selfContactUrl]);

  return (
    <div style={{ display: 'flex', gap: '0.25em', alignItems: 'center', height: '100%' }}>
      {Object.keys(taskQueueUrls).map((taskQueueUrl) => (
        <Suspense key={taskQueueUrl} fallback={null}>
          <TaskQueue
            element={element}
            taskQueueUrl={taskQueueUrl as AutomergeUrl}
          />
        </Suspense>
      ))}
    </div>
  );
};

const TaskQueue: React.FC<{ element: HTMLElement; taskQueueUrl: AutomergeUrl }> = ({
  element,
  taskQueueUrl,
}) => {
  const [{ title, pending, done }] = useDocument<TaskQueueDoc>(taskQueueUrl, { suspense: true });
  return (
    <div
      className="task-titlebar"
      onClick={() => element.dispatchEvent(createOpenEvent({ url: taskQueueUrl }))}
    >
      <span>{title ?? 'TQ'}</span>
      <span>{pending.length}</span>/<span>{done.length}</span>
    </div>
  );
};

function createOpenEvent(detail: OpenDocumentEventDetail) {
  const openEvent = new CustomEvent('patchwork:open-document', {
    detail,
    bubbles: true,
    composed: true,
  });
  return openEvent;
}

function getImportMap() {
  const importMapElement = document.querySelector('script[type="importmap"]');
  if (!importMapElement) {
    return {};
  }

  try {
    return JSON.parse(importMapElement.textContent || '{}');
  } catch (e) {
    console.warn('Failed to parse import map:', e);
    return {};
  }
}
