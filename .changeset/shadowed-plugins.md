---
"@inkandswitch/patchwork-plugins": patch
---

A registry keeps every package's registration of an id, in order: the one in use, then the ones it shadows, in the order they'd take over. When a package overrides another's id, the other's is shadowed rather than replaced: if the overriding package is unregistered, or its next version drops the id, the shadowed one is in use again, without a reload. Before, it was gone until its own package registered again.

A package registering an id for the first time goes first. A package registering again (its next version) keeps its place, so a shadowed package updating doesn't take the id back, and doesn't emit `registered` or `changed`. Before, whichever registered last was in use, so an overridden package took its ids back every time it updated.

`pinPluginSources(isPinned)` pins packages in every registry, including ones made later. `isPinned` takes the url a plugin was registered from. A pinned package's registration is used over any that isn't pinned, whichever registered first. This lets a dev server's packages win over the same packages installed from documents, however the two load:

```ts
pinPluginSources((url) => url?.startsWith(devOrigin) ?? false);
```

`get(id)` and `all()` return the plugins in use, as before. `shadows(id)` returns the registrations the plugin in use for `id` shadows, in the order they'd take over. `remove(id)` removes the registration in use, so the first one it shadowed is in use now. `removeSource(source, keep?)` removes one package's registrations, shadowed ones too, where `source` is a package's `sourceOf` url. `PluginRegistry.pinSources(isPinned)` pins for one registry. `PinnedSources` is exported as a type.
