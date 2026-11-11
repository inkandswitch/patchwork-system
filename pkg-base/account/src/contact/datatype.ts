import { type DatatypeImplementation } from "@inkandswitch/patchwork-plugins";
import type { ContactDoc } from "../types";

export const init = (doc: ContactDoc) => {
  Object.assign(doc, {
    type: "anonymous",
  } as ContactDoc);
};

const getTitle = (doc: ContactDoc) => {
  if (doc.type === "registered") {
    return doc.name;
  }
  return "Anonymous";
};

const setTitle = (doc: ContactDoc, title: string) => {
  if (doc.type === "registered") {
    doc.name = title;
  }
};

export const ContactDatatype: DatatypeImplementation<ContactDoc> = {
  init,
  getTitle,
  setTitle,
};
