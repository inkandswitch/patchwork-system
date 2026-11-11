import type { DocHandle, Repo } from "@automerge/automerge-repo/slim";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import inventoryPurchasing from "./examples/inventoryPurchasing.json";

/**
 * Examples for gaios deployments, seeded in place of the module bundles'
 * generated init scripts. Each entry is built inline (no plugin registry), so
 * a datatype that isn't installed here still gets a well-formed document.
 */
export async function seedGaiosExamples(
  repo: Repo,
  folder: DocHandle<FolderDoc>
) {
  for (const example of EXAMPLES) {
    const handle = await repo.create2(example.doc);
    folder.change((doc) => {
      doc.docs.push({
        name: example.name,
        type: example.doc["@patchwork"].type,
        url: handle.url,
      });
    });
  }
}

const SEIRV = {
  "@patchwork": {
    title: "CatColab: Stock & Flow",
    type: "catcolab-model",
  },
  analysisDocUrl: "automerge:qJJEiMQo21VwaLToRtYENuYSuTC",
  name: "SEIRV",
  notebook: {
    cellContents: {
      "0194d7a9-bc26-73ac-b2b8-73470cb412ae": {
        content: {
          id: "0194d7a9-bc26-73ac-b2b8-6eb9a514827b",
          name: "Susceptible",
          obType: { content: "Object", tag: "Basic" },
          tag: "object",
        },
        id: "0194d7a9-bc26-73ac-b2b8-73470cb412ae",
        tag: "formal",
      },
      "0194d7a9-bf28-709f-b34d-545928dd7c16": {
        content: {
          id: "0194d7a9-bf28-709f-b34d-513c3da75e9c",
          name: "Infectious",
          obType: { content: "Object", tag: "Basic" },
          tag: "object",
        },
        id: "0194d7a9-bf28-709f-b34d-545928dd7c16",
        tag: "formal",
      },
      "0194d7a9-c036-745b-99e2-b3ef2d3b87d0": {
        content: {
          id: "0194d7a9-c036-745b-99e2-aedb526915c7",
          name: "Recovered",
          obType: { content: "Object", tag: "Basic" },
          tag: "object",
        },
        id: "0194d7a9-c036-745b-99e2-b3ef2d3b87d0",
        tag: "formal",
      },
      "0194d7a9-d72e-700a-9c8b-7686fad4193b": {
        content: {
          cod: { content: "0194fc13-3da9-77cb-b36a-9b8a6a83f0e6", tag: "Basic" },
          dom: { content: "0194d7a9-bc26-73ac-b2b8-6eb9a514827b", tag: "Basic" },
          id: "0194d7a9-d72e-700a-9c8b-703b753da038",
          morType: {
            content: { content: "Object", tag: "Basic" },
            tag: "Hom",
          },
          name: "exposure",
          tag: "morphism",
        },
        id: "0194d7a9-d72e-700a-9c8b-7686fad4193b",
        tag: "formal",
      },
      "0194d7a9-d8b5-741f-916f-d559d3ff2f8d": {
        content: {
          cod: { content: "0194d7a9-c036-745b-99e2-aedb526915c7", tag: "Basic" },
          dom: { content: "0194d7a9-bf28-709f-b34d-513c3da75e9c", tag: "Basic" },
          id: "0194d7a9-d8b5-741f-916f-d3dd802450ec",
          morType: {
            content: { content: "Object", tag: "Basic" },
            tag: "Hom",
          },
          name: "recovery",
          tag: "morphism",
        },
        id: "0194d7a9-d8b5-741f-916f-d559d3ff2f8d",
        tag: "formal",
      },
      "0194d7a9-f4ff-77df-80a5-75410f4b9680": {
        content: {
          cod: {
            content: {
              content: "0194d7a9-d72e-700a-9c8b-703b753da038",
              tag: "Basic",
            },
            tag: "Tabulated",
          },
          dom: { content: "0194d7a9-bf28-709f-b34d-513c3da75e9c", tag: "Basic" },
          id: "0194d7a9-f4ff-77df-80a5-70d50473ed6d",
          morType: { content: "Link", tag: "Basic" },
          name: "",
          tag: "morphism",
        },
        id: "0194d7a9-f4ff-77df-80a5-75410f4b9680",
        tag: "formal",
      },
      "0194d7c1-3b04-77cf-b2c1-e4e8a10712e2": {
        content:
          "This stock-flow diagram exhibits the standard SIR model from epidemiology augmented with Exposed and Vaccinated populations: there are populations of susceptible, exposed, infectious, vaccinated, and recovered subjects, and processes flow among these stocks. A link from the infectious population to the infection process reflects that the infection rate increases as the density of infectious subjects does.",
        id: "0194d7c1-3b04-77cf-b2c1-e4e8a10712e2",
        tag: "rich-text",
      },
      "0194fc13-2920-724c-a6c3-fc1d17699223": {
        content: {
          id: "0194fc13-2920-724c-a6c3-f85ca780f6cf",
          name: "Vaccinated",
          obType: { content: "Object", tag: "Basic" },
          tag: "object",
        },
        id: "0194fc13-2920-724c-a6c3-fc1d17699223",
        tag: "formal",
      },
      "0194fc13-3da9-77cb-b36a-9c5b8a74d941": {
        content: {
          id: "0194fc13-3da9-77cb-b36a-9b8a6a83f0e6",
          name: "Exposed",
          obType: { content: "Object", tag: "Basic" },
          tag: "object",
        },
        id: "0194fc13-3da9-77cb-b36a-9c5b8a74d941",
        tag: "formal",
      },
      "0194fc13-d6aa-741c-a30c-54cd59aaee10": {
        content: {
          cod: { content: "0194d7a9-bf28-709f-b34d-513c3da75e9c", tag: "Basic" },
          dom: { content: "0194fc13-3da9-77cb-b36a-9b8a6a83f0e6", tag: "Basic" },
          id: "0194fc13-d6aa-741c-a30c-536d48c10c1e",
          morType: {
            content: { content: "Object", tag: "Basic" },
            tag: "Hom",
          },
          name: "infection",
          tag: "morphism",
        },
        id: "0194fc13-d6aa-741c-a30c-54cd59aaee10",
        tag: "formal",
      },
      "0194fc14-204c-72a4-92fa-df5491673bab": {
        content: {
          cod: { content: "0194fc13-2920-724c-a6c3-f85ca780f6cf", tag: "Basic" },
          dom: { content: "0194d7a9-bc26-73ac-b2b8-6eb9a514827b", tag: "Basic" },
          id: "0194fc14-204c-72a4-92fa-da1399afa430",
          morType: {
            content: { content: "Object", tag: "Basic" },
            tag: "Hom",
          },
          name: "vaccination",
          tag: "morphism",
        },
        id: "0194fc14-204c-72a4-92fa-df5491673bab",
        tag: "formal",
      },
      "01981982-b589-702c-99a8-57983e3bd08e": {
        content: {
          cod: { content: "0194d7a9-bc26-73ac-b2b8-6eb9a514827b", tag: "Basic" },
          dom: { content: "0194fc13-2920-724c-a6c3-f85ca780f6cf", tag: "Basic" },
          id: "01981982-b589-702c-99a8-539c45521dc9",
          morType: {
            content: { content: "Object", tag: "Basic" },
            tag: "Hom",
          },
          name: "waning",
          tag: "morphism",
        },
        id: "01981982-b589-702c-99a8-57983e3bd08e",
        tag: "formal",
      },
      "019ffc10-1a2b-73c1-9f01-4d5e6a7b8c01": {
        content: {
          cod: { content: "0194fc13-3da9-77cb-b36a-9b8a6a83f0e6", tag: "Basic" },
          dom: { content: "0194d7a9-c036-745b-99e2-aedb526915c7", tag: "Basic" },
          id: "019ffc10-1a2b-73c1-9f01-4d5e6a7b8c02",
          morType: {
            content: { content: "Object", tag: "Basic" },
            tag: "Hom",
          },
          name: "reinfection",
          tag: "morphism",
        },
        id: "019ffc10-1a2b-73c1-9f01-4d5e6a7b8c01",
        tag: "formal",
      },
      "019ffc10-3c4d-74e2-8a12-5e6f7a8b9c11": {
        content: {
          cod: {
            content: {
              content: "019ffc10-1a2b-73c1-9f01-4d5e6a7b8c02",
              tag: "Basic",
            },
            tag: "Tabulated",
          },
          dom: { content: "0194d7a9-bf28-709f-b34d-513c3da75e9c", tag: "Basic" },
          id: "019ffc10-3c4d-74e2-8a12-5e6f7a8b9c12",
          morType: { content: "Link", tag: "Basic" },
          name: "",
          tag: "morphism",
        },
        id: "019ffc10-3c4d-74e2-8a12-5e6f7a8b9c11",
        tag: "formal",
      },
    },
    cellOrder: [
      "0194d7c1-3b04-77cf-b2c1-e4e8a10712e2",
      "0194d7a9-bc26-73ac-b2b8-73470cb412ae",
      "0194fc13-3da9-77cb-b36a-9c5b8a74d941",
      "0194d7a9-bf28-709f-b34d-545928dd7c16",
      "0194d7a9-c036-745b-99e2-b3ef2d3b87d0",
      "0194fc13-2920-724c-a6c3-fc1d17699223",
      "0194d7a9-d72e-700a-9c8b-7686fad4193b",
      "0194fc14-204c-72a4-92fa-df5491673bab",
      "0194fc13-d6aa-741c-a30c-54cd59aaee10",
      "0194d7a9-d8b5-741f-916f-d559d3ff2f8d",
      "0194d7a9-f4ff-77df-80a5-75410f4b9680",
      "01981982-b589-702c-99a8-57983e3bd08e",
      "019ffc10-1a2b-73c1-9f01-4d5e6a7b8c01",
    ],
  },
  theory: "primitive-stock-flow",
  type: "model",
  version: "2",
};

const EXAMPLES = [
  { name: "CatColab: Stock & Flow", doc: SEIRV },
  { name: "Petri Net: Inventory purchasing", doc: inventoryPurchasing },
];
