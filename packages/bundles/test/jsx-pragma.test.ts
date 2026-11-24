import { describe, expect, it } from "vitest";
import { jsxImportSource, jsxPragmas } from "../src/jsx-pragma.js";

describe("jsxImportSource", () => {
  it("reads the import source from a leading block comment", () => {
    expect(
      jsxImportSource(
        `/** @jsxImportSource react */\nexport const a = <div />;`
      )
    ).toBe("react");
  });

  it("reads several pragmas from one comment", () => {
    expect(
      jsxPragmas(
        `/**\n * @jsxRuntime automatic\n * @jsxImportSource preact\n */\nlet a = 1;`
      )
    ).toEqual({ runtime: "automatic", importsource: "preact" });
  });

  it("ignores a pragma after the first statement, or in a line comment", () => {
    expect(
      jsxImportSource(`let a = 1;\n/** @jsxImportSource react */`)
    ).toBeUndefined();
    expect(
      jsxImportSource(`// @jsxImportSource react\nlet a = 1;`)
    ).toBeUndefined();
  });

  it("has no import source under the classic runtime", () => {
    expect(
      jsxImportSource(
        `/** @jsxRuntime classic @jsxImportSource react */\nlet a = 1;`
      )
    ).toBeUndefined();
  });

  it("reads TypeScript", () => {
    expect(
      jsxImportSource(
        `/** @jsxImportSource react */\nconst f = <T,>(x: T): T => x;`
      )
    ).toBe("react");
  });
});
