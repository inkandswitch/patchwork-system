/**
 * When `repo.find()` resolves, rejects or hangs, between a tab repo and a
 * service worker repo joined by a MessageChannel.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  Repo,
  generateAutomergeUrl,
  type PeerId,
  type SharePolicy,
  type AutomergeUrl,
} from "@automerge/automerge-repo";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";

const shareAll: SharePolicy = async () => true;

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, label = ""): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`timed out after ${ms}ms${label ? `: ${label}` : ""}`)
          ),
        ms
      )
    ),
  ]);
}

interface TestDoc {
  foo: string;
  bar?: string;
}

interface FolderTestDoc {
  title: string;
  docs: Array<{ name: string; url: string; type: string }>;
}

const repos: Repo[] = [];

function createRepo(opts: ConstructorParameters<typeof Repo>[0] = {}): Repo {
  const repo = new Repo(opts);
  repos.push(repo);
  return repo;
}

afterEach(async () => {
  await Promise.all(repos.map((r) => r.shutdown().catch(() => {})));
  repos.length = 0;
});

describe("repo.find() availability", () => {
  it("find() resolves for a doc created on the same repo", async () => {
    const repo = createRepo({
      peerId: "solo" as PeerId,
    });

    const handle = repo.create<TestDoc>();
    handle.change((d) => {
      d.foo = "hello";
    });

    const found = await withTimeout(repo.find<TestDoc>(handle.url), 5000);
    expect(found.doc().foo).toBe("hello");
  });

  it("find() resolves between two repos connected via MessageChannel", async () => {
    const { port1, port2 } = new MessageChannel();

    const repoA = createRepo({
      peerId: "a" as PeerId,
      network: [new MessageChannelNetworkAdapter(port1)],
      sharePolicy: shareAll,
    });

    const repoB = createRepo({
      peerId: "b" as PeerId,
      network: [new MessageChannelNetworkAdapter(port2)],
      sharePolicy: shareAll,
    });

    const handle = repoA.create<TestDoc>();
    handle.change((d) => {
      d.foo = "synced";
    });

    await pause(100);

    const found = await withTimeout(
      repoB.find<TestDoc>(handle.url),
      5000,
      "repoB.find via MessageChannel"
    );
    expect(found.doc().foo).toBe("synced");
  });

  it("find() rejects with 'unavailable' when no peer has the doc", async () => {
    const { port1 } = new MessageChannel();

    const repo = createRepo({
      peerId: "lonely" as PeerId,
      network: [new MessageChannelNetworkAdapter(port1)],
      sharePolicy: shareAll,
    });

    const fakeUrl = generateAutomergeUrl();

    await expect(
      withTimeout(repo.find<TestDoc>(fakeUrl), 5000, "find nonexistent doc")
    ).rejects.toThrow(/unavailable|timed out/);
  });

  describe("networkSubsystem.whenReady()", () => {
    it("resolves when both sides of the MessageChannel are connected", async () => {
      const { port1, port2 } = new MessageChannel();

      const repoA = createRepo({
        peerId: "a" as PeerId,
        network: [new MessageChannelNetworkAdapter(port1)],
      });

      const repoB = createRepo({
        peerId: "b" as PeerId,
        network: [new MessageChannelNetworkAdapter(port2)],
      });

      await withTimeout(
        repoA.networkSubsystem.whenReady(),
        5000,
        "repoA.networkSubsystem.whenReady"
      );
      await withTimeout(
        repoB.networkSubsystem.whenReady(),
        5000,
        "repoB.networkSubsystem.whenReady"
      );
    });

    it("resolves when only one side of the MessageChannel exists (dangling port)", async () => {
      const { port1 } = new MessageChannel();

      const repo = createRepo({
        peerId: "dangling" as PeerId,
        network: [new MessageChannelNetworkAdapter(port1)],
      });

      // port2 never goes to a Repo, as if the SW hadn't connected yet.
      await withTimeout(
        repo.networkSubsystem.whenReady(),
        5000,
        "dangling port whenReady"
      );
    });
  });

  // Documents a live upstream automerge-repo gap — flips to a failure (and
  // should be un-marked) when upstream fixes it.
  it.fails(
    "find() resolves when MessageChannel peer connects after find() is called",
    async () => {
      const { port1, port2 } = new MessageChannel();

      const tabRepo = createRepo({
        peerId: "tab" as PeerId,
        network: [new MessageChannelNetworkAdapter(port1)],
        sharePolicy: shareAll,
      });

      // No network yet: the doc is only on the SW.
      const swRepo = createRepo({
        peerId: "sw" as PeerId,
        sharePolicy: shareAll,
      });

      const handle = swRepo.create<TestDoc>();
      handle.change((d) => {
        d.foo = "from-sw";
      });

      const findPromise = tabRepo.find<TestDoc>(handle.url);
      findPromise.catch(() => {});

      await pause(500);
      swRepo.networkSubsystem.addNetworkAdapter(
        new MessageChannelNetworkAdapter(port2)
      );

      await pause(100);

      const found = await withTimeout(
        findPromise,
        10000,
        "find after late MessageChannel connect"
      );
      expect(found.doc().foo).toBe("from-sw");
    }
  );

  it("find() resolves when the remote creates the doc after find() is called", async () => {
    const { port1, port2 } = new MessageChannel();

    const tabRepo = createRepo({
      peerId: "tab" as PeerId,
      network: [new MessageChannelNetworkAdapter(port1)],
      sharePolicy: shareAll,
    });

    const swRepo = createRepo({
      peerId: "sw" as PeerId,
      network: [new MessageChannelNetworkAdapter(port2)],
      sharePolicy: shareAll,
    });

    await pause(100);

    const handle = swRepo.create<TestDoc>();
    handle.change((d) => {
      d.foo = "late-create";
    });

    const found = await withTimeout(
      tabRepo.find<TestDoc>(handle.url),
      5000,
      "find doc created after channel connect"
    );
    expect(found.doc().foo).toBe("late-create");
  });

  it("a second find() succeeds after the first one rejected with unavailable", async () => {
    const { port1, port2 } = new MessageChannel();

    // port2 isn't connected to anything yet.
    const tabRepo = createRepo({
      peerId: "tab" as PeerId,
      network: [new MessageChannelNetworkAdapter(port1)],
      sharePolicy: shareAll,
    });

    const swRepo = createRepo({
      peerId: "sw" as PeerId,
      sharePolicy: shareAll,
    });

    const handle = swRepo.create<TestDoc>();
    handle.change((d) => {
      d.foo = "retry-me";
    });

    // The query may reject with "unavailable" or hang; either is fine here.
    let firstFailed = false;
    try {
      await withTimeout(
        tabRepo.find<TestDoc>(handle.url),
        3000,
        "first find (expected to fail)"
      );
    } catch {
      firstFailed = true;
    }
    expect(firstFailed).toBe(true);

    swRepo.networkSubsystem.addNetworkAdapter(
      new MessageChannelNetworkAdapter(port2)
    );
    await pause(200);

    const found = await withTimeout(
      tabRepo.find<TestDoc>(handle.url),
      5000,
      "second find after SW connects"
    );
    expect(found.doc().foo).toBe("retry-me");
  });

  it("diagnose: find() behavior when no source can provide the doc", async () => {
    const { port1, port2 } = new MessageChannel();

    const tabRepo = createRepo({
      peerId: "tab" as PeerId,
      network: [new MessageChannelNetworkAdapter(port1)],
      sharePolicy: shareAll,
    });

    createRepo({
      peerId: "sw" as PeerId,
      network: [new MessageChannelNetworkAdapter(port2)],
      sharePolicy: shareAll,
    });

    await pause(100);

    const fakeUrl = generateAutomergeUrl();

    await expect(
      withTimeout(
        tabRepo.find<TestDoc>(fakeUrl),
        10000,
        "find nonexistent doc with connected peer"
      )
    ).rejects.toThrow(/unavailable|timed out/);
  });

  it("find() for an unknown doc on a repo with no network", async () => {
    const repo = createRepo({
      peerId: "isolated" as PeerId,
    });

    const fakeUrl = generateAutomergeUrl();

    await expect(
      withTimeout(repo.find<TestDoc>(fakeUrl), 5000, "find on isolated repo")
    ).rejects.toThrow(/unavailable|timed out/);
  });

  it("patchwork architecture: Tab repo finds doc via SW relay", async () => {
    const { port1, port2 } = new MessageChannel();

    const swRepo = createRepo({
      peerId: "service-worker" as PeerId,
      network: [new MessageChannelNetworkAdapter(port2)],
      sharePolicy: shareAll,
    });

    const folderHandle = swRepo.create<FolderTestDoc>();
    folderHandle.change((d) => {
      d.title = "test-tool";
      d.docs = [
        { name: "package.json", url: "automerge:fake-pkg", type: "file" },
      ];
    });

    const tabRepo = createRepo({
      peerId: "tab-main" as PeerId,
      network: [new MessageChannelNetworkAdapter(port1)],
      sharePolicy: shareAll,
    });

    await pause(200);

    const found = await withTimeout(
      tabRepo.find<FolderTestDoc>(folderHandle.url),
      5000,
      "tab finds folder doc via SW MessageChannel"
    );

    expect(found.doc().title).toBe("test-tool");
    expect(found.doc().docs).toHaveLength(1);
    expect(found.doc().docs[0].name).toBe("package.json");
  });

  it("patchwork startup race: find() called before SW has the doc, SW gets it later", async () => {
    const { port1, port2 } = new MessageChannel();

    const swRepo = createRepo({
      peerId: "service-worker" as PeerId,
      network: [new MessageChannelNetworkAdapter(port2)],
      sharePolicy: shareAll,
    });

    const tabRepo = createRepo({
      peerId: "tab-main" as PeerId,
      network: [new MessageChannelNetworkAdapter(port1)],
      sharePolicy: shareAll,
    });

    await pause(100); // let adapters connect

    let resolvedUrl: AutomergeUrl | undefined;

    const folderHandle = swRepo.create<FolderTestDoc>();
    folderHandle.change((d) => {
      d.title = "late-tool";
      d.docs = [];
    });
    resolvedUrl = folderHandle.url;

    const found = await withTimeout(
      tabRepo.find<FolderTestDoc>(resolvedUrl),
      5000,
      "tab finds doc that SW creates after connection"
    );
    expect(found.doc().title).toBe("late-tool");
  });

  // Documents a live upstream automerge-repo gap — flips to a failure (and
  // should be un-marked) when upstream fixes it.
  it.fails(
    "critical: tab find() settles after SW receives doc via delayed creation",
    async () => {
      const { port1, port2 } = new MessageChannel();

      const swRepo = createRepo({
        peerId: "service-worker" as PeerId,
        network: [new MessageChannelNetworkAdapter(port2)],
        sharePolicy: shareAll,
      });

      const tabRepo = createRepo({
        peerId: "tab-main" as PeerId,
        network: [new MessageChannelNetworkAdapter(port1)],
        sharePolicy: shareAll,
      });

      await pause(100); // let MessageChannel connect

      const seedRepo = createRepo({ peerId: "seed" as PeerId });
      const seedHandle = seedRepo.create<TestDoc>();
      seedHandle.change((d) => {
        d.foo = "seed-data";
      });
      const targetUrl = seedHandle.url;

      const findPromise = tabRepo.find<TestDoc>(targetUrl);
      findPromise.catch(() => {});

      await pause(1000);
      const { port1: seedToSw, port2: swFromSeed } = new MessageChannel();
      seedRepo.networkSubsystem.addNetworkAdapter(
        new MessageChannelNetworkAdapter(seedToSw)
      );
      swRepo.networkSubsystem.addNetworkAdapter(
        new MessageChannelNetworkAdapter(swFromSeed)
      );

      const found = await withTimeout(
        findPromise,
        10000,
        "tab find() after SW receives doc from seed"
      );
      expect(found.doc().foo).toBe("seed-data");
    }
  );

  // The SW tells the tab doc-unavailable, then gets the doc from a third repo:
  // does it push it on to the tab?
  // Documents a live upstream automerge-repo gap — flips to a failure (and
  // should be un-marked) when upstream fixes it.
  it.fails("SW pushes doc to tab after initial doc-unavailable", async () => {
    const { port1, port2 } = new MessageChannel();

    const swRepo = createRepo({
      peerId: "service-worker" as PeerId,
      network: [new MessageChannelNetworkAdapter(port2)],
      sharePolicy: shareAll,
    });

    const tabRepo = createRepo({
      peerId: "tab-main" as PeerId,
      network: [new MessageChannelNetworkAdapter(port1)],
      sharePolicy: shareAll,
    });

    await pause(100); // let MessageChannel connect

    const seedRepo = createRepo({ peerId: "seed" as PeerId });
    const seedHandle = seedRepo.create<TestDoc>();
    seedHandle.change((d) => {
      d.foo = "from-subduction";
    });
    const targetUrl = seedHandle.url;

    const findPromise = tabRepo.find<TestDoc>(targetUrl);
    findPromise.catch(() => {});

    // The SW says doc-unavailable within ~50ms.
    await pause(500);

    let resolved = false;
    findPromise
      .then(() => {
        resolved = true;
      })
      .catch(() => {});
    expect(resolved).toBe(false);

    const { port1: seedToSw, port2: swFromSeed } = new MessageChannel();
    seedRepo.networkSubsystem.addNetworkAdapter(
      new MessageChannelNetworkAdapter(seedToSw)
    );
    swRepo.networkSubsystem.addNetworkAdapter(
      new MessageChannelNetworkAdapter(swFromSeed)
    );

    const found = await withTimeout(
      findPromise,
      10000,
      "tab find() after SW gets doc from seed (post doc-unavailable)"
    );
    expect(found.doc().foo).toBe("from-subduction");
  });

  it("tab find() resolves when SW already has doc from prior sync", async () => {
    const { port1, port2 } = new MessageChannel();

    const swRepo = createRepo({
      peerId: "service-worker" as PeerId,
      network: [new MessageChannelNetworkAdapter(port2)],
      sharePolicy: shareAll,
    });

    const tabRepo = createRepo({
      peerId: "tab-main" as PeerId,
      network: [new MessageChannelNetworkAdapter(port1)],
      sharePolicy: shareAll,
    });

    await pause(100); // let MessageChannel connect

    const handle = swRepo.create<TestDoc>();
    handle.change((d) => {
      d.foo = "already-prefetched";
    });

    await pause(200);

    const found = await withTimeout(
      tabRepo.find<TestDoc>(handle.url),
      5000,
      "tab find() when SW already has doc"
    );
    expect(found.doc().foo).toBe("already-prefetched");
  });

  // The module watcher finds all its packages at once.
  it("concurrent find() calls from tab all resolve when SW gets doc", async () => {
    const { port1, port2 } = new MessageChannel();

    const swRepo = createRepo({
      peerId: "service-worker" as PeerId,
      network: [new MessageChannelNetworkAdapter(port2)],
      sharePolicy: shareAll,
    });

    const tabRepo = createRepo({
      peerId: "tab-main" as PeerId,
      network: [new MessageChannelNetworkAdapter(port1)],
      sharePolicy: shareAll,
    });

    await pause(100);

    const handle = swRepo.create<TestDoc>();
    handle.change((d) => {
      d.foo = "concurrent";
    });

    await pause(200);

    const results = await withTimeout(
      Promise.all([
        tabRepo.find<TestDoc>(handle.url),
        tabRepo.find<TestDoc>(handle.url),
        tabRepo.find<TestDoc>(handle.url),
      ]),
      5000,
      "concurrent find() calls"
    );

    for (const r of results) {
      expect(r.doc().foo).toBe("concurrent");
    }
  });
});
