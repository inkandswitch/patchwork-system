---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

Every Repo Patchwork builds — each tab's and the automerge protocol handler worker's, on plain and keyhive sites — records its signer's verifying key (hex) as the Automerge `author` of its actors, so a document's history tells which actors signed as this browser profile (`Automerge.getActorsForAuthor(doc, patchwork.signer.verifyingKey)`). The Repo takes it as `author` in its config, from the workspace's automerge-repo patch, which creates documents with it and sets it again after every mutation because a load into an empty document drops it.

`@inkandswitch/patchwork-bootloader/signer` exports `signerIdentity(signer)`, the signer's Subduction peer id and hex verifying key. `patchwork.signer` is now set on keyhive sites too, from the signer ARK derives from the keyhive active keypair.
