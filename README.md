# Patchwork

This repository holds the Patchwork System, and the famous Patchwork frame.

## Getting started

```shell
git clone https://github.com/inkandswitch/patchwork-system
cd patchwork-system
pnpm install
pnpm build
SITE=gaios.sgai.uk pnpm dev
```

To run a specific site, set `SITE` to a directory name under `sites/`:

```shell
SITE=gaios.sgai.uk pnpm dev
```

> [!NOTE]
> The Patchwork site itself now lives in its own repository:
> [patchwork.inkandswitch.com](https://github.com/inkandswitch/patchwork.inkandswitch.com).

The development server will be running at [localhost:5173](http://localhost:5173/).
