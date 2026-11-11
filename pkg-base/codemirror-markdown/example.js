// Example document for fresh accounts (aggregated into the bundle's init.js):
// a markdown essay introducing the lab. Standalone: builds the doc shape
// inline instead of going through the plugin registry.

const CONTENT =
  `# Welcome to Patchwork

We're so glad you're here. Patchwork is a malleable software platform for collaborative documents. (Automerge, to be specific.)

Everything you see is a document! This is a document. The sidebar on the left is a document. You can make documents and use different kinds of editors to work with them. Everything you do here is synchronized through our team's sync server -- subduction.sync.inkandswitch.com -- so you can use it across devices and between people.

This is YOUR document. Although it's something we've written, we made a copy of it when we set up your initial patchwork so feel free to edit this one.

A reminder: even though the documents live on your computer, the name of the document (as in Rumplestiltskin) gives you power over it. If you share a link to a document with someone -- especially to the code for a tool -- that person and anyone *they* share with will be able to edit it. We recommend keeping Patchwork links off of social media but... I guess it's up to you?

## Things to try

Look at the other example documents, make some changes, maybe open the link to the document in an incognito window or another browser. Share a link with someone you trust and work together. That's what we do every day at Ink & Switch.

Swap out your editor: use the "Open with..." to switch to the Raw editor. It's an editor that works on EVERY kind of document and shows you the internal structure. You can edit that too, but if you break a document you'll have to fix it.

Don't like what you did to a document? You can use the Drafts tool in the right-hand sidebar to go back in time and make a draft at an earlier point.

Want to invite an LLM to be a guest? Try typing \`/model\` in the Watercooler sidebar and you should be able to either install a local model or paste in an OpenRouter key to chat with anything they offer. Their changes will show up in the document's history, just like yours.

## Let's make some new tools

Patchwork really comes into its own once you start bringing your own tools into the environment. What you have so far is our team's default set of well-maintained tools. We've got a whole pile of extra tools that are of ... indifferent disposition you can find the source of all the tools in th [patchwork base repo](https://github.com/inkandswitch/patchwork-base) and even more experimental tools in our [experiemental repo](https://github.com/inkandswitch/patchwork-experimental)
`;

export default async function example(repo) {
  const handle = await repo.create2({
    "@patchwork": {
      type: "essay",
      suggestedImportUrl: new URL("./dist/main.js", import.meta.url).href,
    },
    content: CONTENT,
  });

  return {
    name: "Ink & Switch",
    type: "essay",
    url: handle.url,
  };
}
