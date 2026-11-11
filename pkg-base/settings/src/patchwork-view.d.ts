declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "patchwork-view": {
        class?: string;
        style?: string | Record<string, string>;
        "doc-url"?: string;
        "tool-id"?: string;
        component?: string;
        key?: string | number;
      };
    }
  }
}

export {};
