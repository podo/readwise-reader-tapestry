const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "local.readwise.reader", "plugin.js"),
  "utf8"
);

function makeContext(overrides = {}) {
  const state = new Map();
  const sample = {
    count: 2,
    nextPageCursor: null,
    results: [
      {
        id: "doc-1",
        url: "https://read.readwise.io/feed/read/doc-1",
        source_url: "https://example.com/article",
        title: "A useful article",
        author: "Example Author",
        source: "Reader RSS",
        category: "rss",
        location: "feed",
        site_name: "Example",
        reading_time: "4 mins",
        summary: "Summary with <unsafe> markup & symbols.",
        image_url: "https://example.com/cover.jpg",
        parent_id: null,
        first_opened_at: null,
        saved_at: "2026-08-29T10:00:00Z"
      },
      {
        id: "highlight-1",
        parent_id: "doc-1",
        summary: "Nested highlights must not become timeline items.",
        saved_at: "2026-08-29T10:01:00Z"
      }
    ]
  };

  const context = {
    console,
    URL,
    api_token: "reader-token",
    reader_location: "Feed",
    document_category: "All",
    content_detail: "Summary",
    open_target: "Reader",
    only_unseen: "off",
    batch_size: "50",
    sendRequest: async (url, method, parameters, headers) => {
      context.lastRequest = { url, method, parameters, headers };
      return JSON.stringify(sample);
    },
    processVerification: value => { context.verification = value; },
    processResults: value => { context.results = value; },
    processError: error => { context.error = error; },
    getItem: key => state.get(key) || null,
    setItem: (key, value) => state.set(key, value),
    Item: {
      createWithUriDate: (uri, date) => ({ uri, date })
    },
    Identity: {
      createWithName: name => ({ name })
    },
    Annotation: {
      createWithText: text => ({ text })
    },
    ...overrides
  };

  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
}

async function run() {
  const context = makeContext();

  vm.runInContext("verify()", context);
  await settle();
  assert.ifError(context.error);
  assert.strictEqual(context.verification.displayName, "Reader · Feed");
  assert.strictEqual(context.lastRequest.headers.Authorization, "Token reader-token");

  vm.runInContext("load()", context);
  await settle();
  assert.ifError(context.error);
  assert.strictEqual(context.results.length, 1);
  assert.strictEqual(context.results[0].title, "A useful article");
  assert.strictEqual(context.results[0].uri, "https://read.readwise.io/feed/read/doc-1");
  assert.match(context.results[0].body, /&lt;unsafe&gt;/);
  assert.doesNotMatch(context.results[0].body, /<unsafe>/);
  assert.match(context.results[0].annotations[0].text, /RSS/);

  const originalContext = makeContext({ open_target: "Original Website" });
  vm.runInContext("load()", originalContext);
  await settle();
  assert.strictEqual(originalContext.results[0].uri, "https://example.com/article");

  const missingToken = makeContext({ api_token: "" });
  vm.runInContext("verify()", missingToken);
  await settle();
  assert.match(missingToken.error.message, /Reader API token/);

  console.log("All Readwise Reader connector tests passed.");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
