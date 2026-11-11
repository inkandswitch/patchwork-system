import "./contact/styles.css";
import "./picker/styles.css";

export const plugins = [
  {
    type: "patchwork:datatype",
    id: "contact",
    name: "Contact",
    icon: "User",
    unlisted: true,
    async load() {
      const { ContactDatatype } = await import("./contact/datatype");
      return ContactDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "contact",
    name: "Contact Viewer",
    supportedDatatypes: ["contact"],
    async load() {
      const { renderContactViewer } = await import("./contact/ContactViewer");
      const { styled } = await import("./styles");
      return styled(renderContactViewer);
    },
  },
  {
    type: "patchwork:tool",
    id: "contact-avatar",
    name: "Contact Avatar",
    supportedDatatypes: ["contact"],
    async load() {
      const { renderContactAvatar } = await import("./contact/ContactAvatar");
      const { styled } = await import("./styles");
      return styled(renderContactAvatar);
    },
  },
  {
    type: "patchwork:tool",
    id: "contact-inline",
    name: "Inline Contact Avatar",
    supportedDatatypes: ["contact"],
    async load() {
      const { renderInlineContactAvatar } = await import(
        "./contact/InlineContactAvatar"
      );
      const { styled } = await import("./styles");
      return styled(renderInlineContactAvatar);
    },
  },
  {
    type: "patchwork:tool",
    id: "contact-cursor",
    name: "Contact Cursor",
    supportedDatatypes: ["contact"],
    async load() {
      const { renderContactCursor } = await import("./contact/ContactCursor");
      const { styled } = await import("./styles");
      return styled(renderContactCursor);
    },
  },
  {
    type: "patchwork:tool",
    id: "account-picker",
    name: "Account Picker",
    supportedDatatypes: ["account"],
    async load() {
      const { AccountPickerTool } = await import("./picker/AccountPicker");
      const { styled } = await import("./styles");
      return styled(AccountPickerTool);
    },
  },
];
