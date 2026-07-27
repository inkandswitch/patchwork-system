import {
  type AccountCreator,
  type AccountDoc,
  type DatatypeDescription,
  createDocOfDatatype2,
  getRegistry,
} from "@inkandswitch/patchwork-plugins";

export const createDefaultAccount: AccountCreator<AccountDoc> = async (
  accountHandle,
  repo
) => {
  const fields = [
    ["rootFolderUrl", "folder"],
    ["moduleSettingsUrl", "patchwork:module-settings"],
    ["contactUrl", "contact"],
  ] as const;
  const registry = getRegistry<DatatypeDescription>("patchwork:datatype");

  const subdocs = await Promise.all(
    fields.map(async ([field, datatypeId]) => {
      const datatype = await registry.loadWhenReady(datatypeId);
      const handle = await createDocOfDatatype2(datatype, repo);
      return [field, handle.url] as const;
    })
  );

  accountHandle.change((doc) => {
    for (const [field, url] of subdocs) doc[field] = url;
  });
};
