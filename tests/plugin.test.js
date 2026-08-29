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
        reading_progress: 0.42,
        word_count: 1234,
        tags: { research: "Research", ai: "AI" },
        notes: "Remember <this> & revisit.",
        summary: "Summary with <unsafe> markup & symbols.",
        image_url: "https://example.com/cover.jpg",
        parent_id: null,
        first_opened_at: null,
        seen: false,
        published_date: "2026-08-28T08:00:00Z",
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
    required_tags: "",
    metadata_detail: "Rich",
    show_tags: "on",
    show_notes: "off",
    enable_reader_actions: "off",
    batch_size: "50",
    sendRequest: async (url, method, parameters, headers) => {
      context.lastRequest = { url, method, parameters, headers };
      return JSON.stringify(sample);
    },
    processVerification: value => { context.verification = value; },
    processResults: value => { context.results = value; },
    processError: error => { context.error = error; },
    actionComplete: (result, error) => { context.actionResult = result; context.actionError = error; },
    getItem: key => state.get(key) || null,
    setItem: (key, value) => state.set(key, value),
    _state: state,
    lookupIcon: async url => {
      context.iconLookupCount = (context.iconLookupCount || 0) + 1;
      context.lastIconLookup = url;
      return "https://example.com/apple-touch-icon-180x180.png";
    },
    Item: {
      createWithUriDate: (uri, date) => ({ uri, date })
    },
    Identity: {
      createWithName: name => ({ name })
    },
    Annotation: {
      createWithText: text => ({ text })
    },
    LinkAttachment: {
      createWithUrl: url => ({ url })
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
  assert.strictEqual(context.results[0].date.toISOString(), "2026-08-28T08:00:00.000Z");
  assert.match(context.results[0].body, /&lt;unsafe&gt;/);
  assert.doesNotMatch(context.results[0].body, /<unsafe>/);
  assert.match(context.results[0].annotations[0].text, /RSS/);
  assert.match(context.results[0].annotations[0].text, /42% read/);
  assert.match(context.results[0].annotations[0].text, /1,234 words/);
  assert.strictEqual(context.results[0].annotations[1].text, "Tags: Research, AI");
  assert.strictEqual(context.results[0].attachments[0].url, "https://example.com/article");
  assert.strictEqual(context.results[0].attachments[0].image, "https://example.com/cover.jpg");
  assert.strictEqual(
    context.results[0].author.avatar,
    "https://example.com/apple-touch-icon-180x180.png"
  );
  assert.strictEqual(context.iconLookupCount, 1);

  vm.runInContext("load()", context);
  await settle();
  assert.strictEqual(context.iconLookupCount, 1, "site icons should be cached by origin");

  context.reader_location = "Later";
  vm.runInContext("load()", context);
  await settle();
  assert.doesNotMatch(context.lastRequest.url, /updatedAfter=/, "filter changes must reset sync state");

  const originalContext = makeContext({ open_target: "Original Website" });
  vm.runInContext("load()", originalContext);
  await settle();
  assert.strictEqual(originalContext.results[0].uri, "https://example.com/article");

  const tinyIconContext = makeContext({
    lookupIcon: async () => "https://example.com/favicon-32x32.png"
  });
  vm.runInContext("load()", tinyIconContext);
  await settle();
  assert.strictEqual(tinyIconContext.results[0].author.avatar, undefined);

  const richContext = makeContext({
    required_tags: "research, ai, later, deep, fifth, ignored",
    show_notes: "on"
  });
  vm.runInContext("load()", richContext);
  await settle();
  assert.match(richContext.lastRequest.url, /tag=research/);
  assert.match(richContext.lastRequest.url, /tag=ai/);
  assert.doesNotMatch(richContext.lastRequest.url, /ignored/);
  assert.match(richContext.results[0].body, /Reader note:/);
  assert.match(richContext.results[0].body, /&lt;this&gt; &amp; revisit/);

  const actionsContext = makeContext({ enable_reader_actions: "on" });
  vm.runInContext("load()", actionsContext);
  await settle();
  const actionItem = actionsContext.results[0];
  assert.ok(actionItem.actions.mark_seen);
  assert.ok(actionItem.actions.move_later);
  vm.runInContext(
    `performAction("mark_seen", ${JSON.stringify(JSON.stringify({ id: "doc-1", location: "feed", seen: false }))}, results[0])`,
    actionsContext
  );
  await settle();
  assert.ifError(actionsContext.actionError);
  assert.strictEqual(actionsContext.lastRequest.method, "PATCH");
  assert.match(actionsContext.lastRequest.url, /\/api\/v3\/update\/doc-1\/$/);
  assert.deepStrictEqual(JSON.parse(actionsContext.lastRequest.parameters), { seen: true });
  assert.ok(actionsContext.actionResult.actions.mark_unseen);
  assert.ok(!actionsContext.actionResult.actions.mark_seen);
  assert.doesNotMatch(actionsContext.actionResult.annotations[0].text, /Unseen in Reader/);

  const pageCalls = [];
  const paginationContext = makeContext({
    sendRequest: async url => {
      pageCalls.push(url);
      const match = url.match(/[?&]pageCursor=([^&]+)/);
      const cursor = match ? decodeURIComponent(match[1]) : null;
      const index = cursor ? Number(cursor.replace("cursor-", "")) : 0;
      const nextPageCursor = index < 5 ? `cursor-${index + 1}` : null;
      return JSON.stringify({
        count: 6,
        nextPageCursor,
        results: [{
          id: `page-doc-${index}`,
          url: `https://read.readwise.io/feed/read/page-doc-${index}`,
          source_url: `https://example.com/page-${index}`,
          title: `Page ${index}`,
          category: "rss",
          location: "feed",
          site_name: "Example",
          summary: "Page summary",
          parent_id: null,
          saved_at: `2026-08-29T10:0${index}:00Z`
        }]
      });
    }
  });
  const paginationSignature = vm.runInContext("currentSyncSignature()", paginationContext);
  paginationContext._state.set("syncStateV2", JSON.stringify({
    signature: paginationSignature,
    updatedAfter: "2026-08-29T09:00:00.000Z",
    pageCursor: null,
    windowStartedAt: null
  }));
  vm.runInContext("load()", paginationContext);
  await settle();
  const pendingState = JSON.parse(paginationContext._state.get("syncStateV2"));
  assert.strictEqual(pageCalls.length, 5);
  assert.strictEqual(pendingState.pageCursor, "cursor-5");
  assert.strictEqual(pendingState.updatedAfter, "2026-08-29T09:00:00.000Z");

  vm.runInContext("load()", paginationContext);
  await settle();
  const completedState = JSON.parse(paginationContext._state.get("syncStateV2"));
  assert.strictEqual(pageCalls.length, 6);
  assert.strictEqual(completedState.pageCursor, null);
  assert.notStrictEqual(completedState.updatedAfter, "2026-08-29T09:00:00.000Z");

  const rateLimitContext = makeContext({
    sendRequest: async () => JSON.stringify({
      status: 429,
      headers: { "Retry-After": "30" },
      body: "{}"
    })
  });
  vm.runInContext("load()", rateLimitContext);
  await settle();
  assert.match(rateLimitContext.error.message, /30 seconds/);
  assert.strictEqual(rateLimitContext._state.get("syncStateV2"), undefined);

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
