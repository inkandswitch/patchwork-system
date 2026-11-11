export function createCommandPalette(root) {
  let open = false;
  let search = "";
  let selectedCommand = null;
  let argValues = [];
  let selectedIndex = 0;

  let backdrop = null;

  function el(tag, attrs, ...children) {
    const element = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith("on")) {
          element.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === "className") {
          element.className = value;
        } else {
          element.setAttribute(key, value);
        }
      }
    }
    for (const child of children) {
      if (typeof child === "string") {
        element.appendChild(document.createTextNode(child));
      } else if (child) {
        element.appendChild(child);
      }
    }
    return element;
  }

  function getFilteredCommands() {
    const commands = window.commands || [];
    if (!search) return commands;
    const lower = search.toLowerCase();
    return commands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(lower) ||
        (cmd.description && cmd.description.toLowerCase().includes(lower))
    );
  }

  function getGroupedCommands(filtered) {
    const groups = {};
    for (const cmd of filtered) {
      const category = cmd.category || "Commands";
      if (!groups[category]) groups[category] = [];
      groups[category].push(cmd);
    }
    return groups;
  }

  function getFlatList(filtered) {
    return filtered;
  }

  function close() {
    open = false;
    search = "";
    selectedCommand = null;
    argValues = [];
    selectedIndex = 0;
    render();
  }

  function show() {
    open = true;
    search = "";
    selectedCommand = null;
    argValues = [];
    selectedIndex = 0;
    render();
  }

  async function handleSelect(cmd) {
    if (cmd.args && cmd.args.length > 0) {
      selectedCommand = cmd;
      argValues = new Array(cmd.args.length).fill("");
      render();
    } else {
      close();
      await cmd.action();
    }
  }

  async function handleArgSubmit(e) {
    e.preventDefault();
    if (!selectedCommand) return;
    const cmd = selectedCommand;
    const vals = [...argValues];
    close();
    await cmd.action(...vals);
  }

  function handleBack() {
    selectedCommand = null;
    argValues = [];
    render();
  }

  function renderArgForm() {
    const cmd = selectedCommand;
    return el(
      "div",
      {
        className: "command-palette-backdrop",
        onClick: close,
      },
      el(
        "div",
        {
          className: "command-palette-container",
          onClick: (e) => e.stopPropagation(),
        },
        el(
          "div",
          { className: "command-palette-header" },
          el(
            "button",
            {
              className: "command-palette-back-button",
              onClick: handleBack,
            },
            "← Back"
          ),
          el("span", { className: "command-palette-header-title" }, cmd.label)
        ),
        el(
          "form",
          {
            className: "command-palette-arg-form",
            onSubmit: handleArgSubmit,
          },
          ...cmd.args.map((arg, index) =>
            el(
              "div",
              { className: "command-palette-arg-input-group" },
              el(
                "label",
                { className: "command-palette-arg-label" },
                arg.name,
                arg.description
                  ? el(
                      "span",
                      { className: "command-palette-arg-description" },
                      arg.description
                    )
                  : null
              ),
              (() => {
                const input = el("input", {
                  type: "text",
                  placeholder: arg.placeholder || "",
                  className: "command-palette-arg-input",
                });
                input.value = argValues[index];
                input.addEventListener("input", (e) => {
                  argValues[index] = e.target.value;
                });
                if (index === 0) {
                  setTimeout(() => input.focus(), 0);
                }
                return input;
              })()
            )
          ),
          el(
            "div",
            { className: "command-palette-arg-actions" },
            el(
              "button",
              {
                type: "button",
                className:
                  "command-palette-arg-button command-palette-arg-button-cancel",
                onClick: handleBack,
              },
              "Cancel"
            ),
            el(
              "button",
              {
                type: "submit",
                className:
                  "command-palette-arg-button command-palette-arg-button-submit",
              },
              "Run Command"
            )
          )
        )
      )
    );
  }

  function renderCommandList() {
    const filtered = getFilteredCommands();
    const grouped = getGroupedCommands(filtered);
    const flat = getFlatList(filtered);

    const input = el("input", {
      type: "text",
      placeholder: "Type a command or search...",
      className: "command-palette-input",
    });
    input.value = search;
    input.addEventListener("input", (e) => {
      search = e.target.value;
      selectedIndex = 0;
      updateList();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, flat.length - 1);
        updateSelection();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        updateSelection();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const currentFiltered = getFilteredCommands();
        if (currentFiltered[selectedIndex]) {
          handleSelect(currentFiltered[selectedIndex]);
        }
      }
    });

    const list = el("div", { className: "command-palette-list" });

    function buildListContent(cmds) {
      const g = getGroupedCommands(cmds);
      const items = [];
      for (const [category, categoryItems] of Object.entries(g)) {
        const heading = el(
          "div",
          { className: "command-palette-group-heading" },
          category
        );
        items.push(heading);
        for (const cmd of categoryItems) {
          const idx = cmds.indexOf(cmd);
          const item = el(
            "div",
            {
              className: "command-palette-item",
              onClick: () => handleSelect(cmd),
              onMouseenter: () => {
                selectedIndex = idx;
                updateSelection();
              },
            },
            el(
              "div",
              { className: "command-palette-item-content" },
              el("span", { className: "command-palette-item-label" }, cmd.label),
              cmd.description
                ? el(
                    "span",
                    { className: "command-palette-item-description" },
                    cmd.description
                  )
                : null
            )
          );
          item.dataset.index = idx;
          items.push(item);
        }
      }
      return items;
    }

    function updateList() {
      const currentFiltered = getFilteredCommands();
      list.innerHTML = "";
      if (currentFiltered.length === 0) {
        list.appendChild(
          el(
            "div",
            { className: "command-palette-empty" },
            "No results found."
          )
        );
      } else {
        for (const node of buildListContent(currentFiltered)) {
          list.appendChild(node);
        }
      }
      updateSelection();
    }

    function updateSelection() {
      for (const item of list.querySelectorAll(".command-palette-item")) {
        item.setAttribute(
          "aria-selected",
          item.dataset.index == selectedIndex ? "true" : "false"
        );
      }
      const selected = list.querySelector(
        '.command-palette-item[aria-selected="true"]'
      );
      if (selected) {
        selected.scrollIntoView({ block: "nearest" });
      }
    }

    updateList();

    const container = el(
      "div",
      {
        className: "command-palette-backdrop",
        onClick: close,
      },
      el(
        "div",
        {
          className: "command-palette-container",
          onClick: (e) => e.stopPropagation(),
        },
        input,
        list
      )
    );

    setTimeout(() => input.focus(), 0);

    return container;
  }

  function render() {
    if (backdrop) {
      backdrop.remove();
      backdrop = null;
    }

    if (!open) return;

    if (selectedCommand && selectedCommand.args) {
      backdrop = renderArgForm();
    } else {
      backdrop = renderCommandList();
    }

    root.appendChild(backdrop);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "o" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (open) {
        close();
      } else {
        show();
      }
    }
    if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
    }
  });
}
