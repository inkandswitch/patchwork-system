import { createEffect, type Accessor } from "solid-js";
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Create a CodeMirror extension for dynamically loaded extensions using a Compartment.
 * This allows extensions to be added/removed reactively after the editor is initialized.
 *
 * @param extensions A SolidJS accessor that returns the current set of dynamic extensions
 * @returns A tuple containing the compartment extension and a function to create a reconfiguration effect
 */
export function createDynamicExtensionsCompartment(
  extensions: Accessor<Extension[]>
) {
  const dynamicCompartment = new Compartment();

  // Function to create an effect that reconfigures the compartment when extensions change
  const createReconfigureEffect = (view: EditorView) =>
    createEffect(() => {
      view.dispatch({
        effects: dynamicCompartment.reconfigure(extensions()),
      });
    });

  return [
    dynamicCompartment.of(extensions()),
    createReconfigureEffect,
  ] as const;
}
