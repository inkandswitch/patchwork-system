import { asString } from './links.js';

export const FolderDatatype = {
  init(doc) {
    doc.title = 'New Folder';
    doc.docs = [];
  },
  getTitle: (doc) => asString(doc.title) || 'Unnamed Folder',
  setTitle: (doc, title) => {
    doc.title = title;
  },
};

// A pushwork directory doc: its title lives in its `@patchwork` metadata, and
// its entries are made by pushwork, not here.
export const DirectoryDatatype = {
  init: () => {
    throw new Error("Can't create an empty Directory");
  },
  getTitle: (doc) => asString(doc['@patchwork']?.title) || 'Unnamed Directory',
  setTitle: (doc, title) => {
    doc['@patchwork'].title = title;
  },
};

export const FileDatatype = {
  init: () => {
    throw new Error("Can't create empty File");
  },
  getTitle(doc) {
    return asString(doc.name) || 'Unnamed File';
  },
  setTitle(doc, title) {
    doc.name = title;
  },
};
