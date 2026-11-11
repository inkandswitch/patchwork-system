import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { ItemName } from "./name.tsx";
import { setRenaming } from "../state.ts";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  setRenaming("");
  document.body.innerHTML = "";
});

function mount(name: string) {
  const rename = vi.fn();
  const root = document.createElement("div");
  document.body.append(root);
  setRenaming("row");
  dispose = render(
    () => <ItemName name={name} id="row" rename={rename} />,
    root
  );
  const input = root.querySelector("input")!;
  return { rename, input, form: root.querySelector("form")! };
}

describe("ItemName", () => {
  it("doesn't rename when submitted unchanged", () => {
    const { rename, form } = mount("Notes");
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(rename).not.toHaveBeenCalled();
  });

  it("doesn't rename when blurred unchanged", () => {
    const { rename, input } = mount("Notes");
    input.dispatchEvent(new Event("blur"));
    expect(rename).not.toHaveBeenCalled();
  });

  it("renames when the name changed", () => {
    const { rename, input, form } = mount("Notes");
    input.value = "Plans";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(rename).toHaveBeenCalledWith("Plans");
  });
});
