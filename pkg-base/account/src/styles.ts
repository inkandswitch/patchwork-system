import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";

const STYLE_ID = "patchwork-account-styles";

let css: Promise<string> | undefined;

function loadStyles() {
  const url = new URL("./index.css", import.meta.url);
  css ??= fetch(url).then((response) => response.text());
  return css;
}

/**
 * Both tools in this package share one stylesheet, so they share one
 * <style> element in the head too.
 */
export async function styled<T>(
  render: ToolImplementation<T>
): Promise<ToolImplementation<T>> {
  const textContent = await loadStyles();
  return (handle, element) => {
    const el =
      document.head.querySelector(`#${STYLE_ID}`) ??
      document.createElement("style");
    Object.assign(el, { textContent, id: STYLE_ID });
    document.head.append(el);
    return render(handle, element);
  };
}
