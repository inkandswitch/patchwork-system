{
  description = "Patchwork Next: A malleable software environment for collaborative work";

  inputs = {
    command-utils.url = "git+https://tangled.sh/@expede.wtf/nix-command-utils";
    flake-utils.url = "github:numtide/flake-utils";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
  };

  outputs = {
    self,
    command-utils,
    flake-utils,
    nixpkgs,
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs { inherit system; };

      nodejs = pkgs.nodejs_24;
      pnpm-pkg = pkgs.pnpm;
      pnpm' = "${pnpm-pkg}/bin/pnpm";

      # Pin Playwright's browsers to the Nix-provided driver so E2E runs are
      # reproducible and need no `playwright install` download. The npm
      # `@playwright/test` version in e2e/package.json must match
      # `playwright-driver`'s (check `nix eval nixpkgs#playwright-driver.version`).
      playwrightBrowsers = pkgs.playwright-driver.browsers;

      asModule = command-utils.asModule.${system};
      cmd = command-utils.cmd.${system};
      pnpm = command-utils.pnpm.${system};

      pnpm-cfg = { pnpm = pnpm'; };

      menu = command-utils.commands.${system} [
        (pnpm.build pnpm-cfg)
        (pnpm.dev pnpm-cfg)
        (pnpm.install pnpm-cfg)
        (pnpm.test pnpm-cfg)
        (asModule {
          "clean" = cmd "Remove node_modules and dist" "rm -rf **/node_modules **/dist";
          "dev:tiny" = cmd "Start dev server (patchwork.inkandswitch.com)" "${pnpm'} dev";
          "dev:gaios" = cmd "Start dev server for Gaios" "SITE=gaios ${pnpm'} dev";
          "dev:hive" = cmd "Start dev server for Hive" "SITE=hive ${pnpm'} dev";
          "format" = cmd "Format code" "${pnpm'} format";
          "format:check" = cmd "Check code formatting" "${pnpm'} format:check";
          "preview" = cmd "Preview production build" "${pnpm'} preview";
          "test:e2e" = cmd "Run browser/SW E2E tests (Playwright)" "${pnpm'} test:e2e";
          "bench:ws" = cmd "Bench inline vs worker WebSocket (Playwright)" "${pnpm'} bench:ws";
          "publish:packages" = cmd "Publish packages" "${pnpm'} publish-packages";
          "tsc" = cmd "Run TypeScript compiler" "${pnpm'} tsc";
        })
      ];

    in {
      devShells.default = pkgs.mkShell {
        name = "Patchwork Next Dev Shell";

        nativeBuildInputs = [
          nodejs
          pkgs.eslint
          pkgs.vscode-langservers-extracted
          pkgs.prettierd
          pkgs.typescript
          pkgs.typescript-language-server
          pnpm-pkg
        ] ++ menu;

        # Make Playwright use the Nix-provided browsers (no download needed).
        PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsers;
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

        shellHook = ''
          menu
        '';
      };

      formatter = pkgs.alejandra;
    });
}
