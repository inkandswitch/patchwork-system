export const plugins = [
  {
    type: 'patchwork:datatype',
    id: 'folder',
    name: 'Folder',
    icon: 'Folder',
    async load() {
      const { FolderDatatype } = await import('./datatype.js');
      return FolderDatatype;
    },
  },
  {
    type: 'patchwork:datatype',
    id: 'directory',
    name: 'Directory',
    icon: 'Folder',
    unlisted: true,
    async load() {
      const { DirectoryDatatype } = await import('./datatype.js');
      return DirectoryDatatype;
    },
  },
  {
    type: 'patchwork:tool',
    id: 'folder-viewer',
    name: 'Folder Viewer',
    supportedDatatypes: ['folder', 'directory'],
    async load() {
      const { FolderTool } = await import('./tool.js');
      return FolderTool;
    },
  }
];
