import { Plugin } from '@inkandswitch/patchwork-plugins';

export const plugins: Plugin<any>[] = [
  {
    type: 'patchwork:datatype',
    id: 'task-queue',
    name: 'Task Queue',
    icon: 'CirclePlus',
    unlisted: true,
    load: async () => (await import('./datatype')).TaskQueueDatatype
  },
  {
    type: 'patchwork:tool',
    id: 'task-queue-browser',
    name: 'Task Queue Browser',
    icon: 'CirclePlus',
    supportedDatatypes: ['task-queue'],
    load: async () => (await import('./task-queue-tool')).TaskQueueTool,
  },
  {
    type: 'patchwork:tool',
    id: 'task-titlebar',
    name: 'Task Titlebar',
    icon: 'Square',
    supportedDatatypes: '*',
    unlisted: true,
    tags: ['titlebar-tool'],
    load: async () => (await import('./titlebar-tool')).TitlebarTool,
  },
];
