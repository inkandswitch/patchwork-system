import {
  getRegistry,
  type DatatypeDescription,
  type LoadedDatatype,
} from "@inkandswitch/patchwork-plugins";

export function loadDatatypeWhenReady<D>(
  id: string
): Promise<LoadedDatatype<D>> {
  return getRegistry<DatatypeDescription>(
    "patchwork:datatype"
  ).loadWhenReady(id) as Promise<LoadedDatatype<D>>;
}
