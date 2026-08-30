const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "local.readwise.reader", "plugin.js"),
  "utf8"
);
const actionDefinitions = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "local.readwise.reader", "actions.json"),
  "utf8"
));

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
        listening_time: null,
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
    required_tags: "All",
    metadata_detail: "Rich",
    show_tags: "on",
    show_notes: "off",
    enable_reader_actions: "off",
    batch_size: "50",
    _requests: [],
    sendRequest: async (url, method, parameters, headers) => {
      context.lastRequest = { url, method, parameters, headers };
      context._requests.push(context.lastRequest);
      if (url === "https://readwise.io/api/v2/auth/") {
        return JSON.stringify({ status: 204, headers: {}, body: "" });
      }
      if (url.startsWith("https://readwise.io/api/v3/tags/")) {
        const tags = {
          count: 5,
          nextPageCursor: null,
          results: [
            { key: "research", name: "Research" },
            { key: "ai-key", name: "AI" },
            { key: "later", name: "Later" },
            { key: "deep", name: "Deep" },
            { key: "fifth", name: "Fifth" }
          ]
        };
        return JSON.stringify({ status: 200, headers: {}, body: JSON.stringify(tags) });
      }
      if (/^https:\/\/www\.reddit\.com\/user\//.test(url)) {
        return JSON.stringify({ data: { snoovatar_img: "https://styles.redditmedia.com/profile/avatar.png?x=1&amp;y=2" } });
      }
      if (method === "PATCH") {
        const changes = JSON.parse(parameters);
        Object.assign(sample.results[0], changes);
        if (Object.prototype.hasOwnProperty.call(changes, "seen")) {
          sample.results[0].first_opened_at = changes.seen ? "2026-08-30T08:00:00Z" : null;
        }
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({ id: sample.results[0].id, url: sample.results[0].url })
        });
      }
      return JSON.stringify({ status: 200, headers: {}, body: JSON.stringify(sample) });
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
  assert.strictEqual(context.lastRequest.url, "https://readwise.io/api/v2/auth/");
  assert.strictEqual(context.lastRequest.headers.Authorization, "Token reader-token");

  vm.runInContext("load()", context);
  await settle();
  assert.ifError(context.error);
  assert.strictEqual(context.results.length, 1);
  assert.strictEqual(context.results[0].title, "A useful article");
  assert.strictEqual(context.results[0].uri, "https://read.readwise.io/read/doc-1");
  assert.strictEqual(context.results[0].date.toISOString(), "2026-08-28T08:00:00.000Z");
  assert.match(context.results[0].body, /&lt;unsafe&gt;/);
  assert.doesNotMatch(context.results[0].body, /<unsafe>/);
  assert.doesNotMatch(context.results[0].body, /Open original/);
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
  assert.doesNotMatch(context.lastRequest.url, /[?&]tag=/, "All must not add a tag filter");

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

  const allLocationsContext = makeContext({ reader_location: "All Locations" });
  vm.runInContext("load()", allLocationsContext);
  await settle();
  assert.doesNotMatch(allLocationsContext.lastRequest.url, /[?&]location=/);
  assert.match(allLocationsContext.results[0].annotations[0].text, /Feed/);
  assert.strictEqual(
    allLocationsContext.results[0].date.toISOString(),
    "2026-08-28T08:00:00.000Z"
  );

  const richContext = makeContext({
    required_tags: "Research, AI, later, deep, fifth, ignored",
    show_notes: "on"
  });
  vm.runInContext("load()", richContext);
  await settle();
  assert.match(richContext.lastRequest.url, /tag=research/);
  assert.match(richContext.lastRequest.url, /tag=ai-key/);
  assert.doesNotMatch(richContext.lastRequest.url, /ignored/);
  assert.match(richContext.results[0].body, /Reader note:/);
  assert.match(richContext.results[0].body, /&lt;this&gt; &amp; revisit/);

  const untaggedContext = makeContext({ required_tags: "Untagged" });
  vm.runInContext("load()", untaggedContext);
  await settle();
  assert.match(untaggedContext.lastRequest.url, /[?&]tag=(?:&|$)/);

  const unknownTagContext = makeContext({ required_tags: "Does Not Exist" });
  vm.runInContext("verify()", unknownTagContext);
  await settle();
  assert.match(unknownTagContext.error.message, /tag not found/i);

  const nestedTags = vm.runInContext(
    `documentTagNames({ research: { name: "Research", type: "manual" }, ai: "AI" })`,
    context
  );
  assert.deepStrictEqual(Array.from(nestedTags), ["Research", "AI"]);

  const videoAnnotation = vm.runInContext(
    `documentAnnotations({ category: "video", location: "feed", listening_time: "12 mins", reading_time: "4 mins", tags: {} })[0].text`,
    context
  );
  assert.match(videoAnnotation, /12 mins/);
  assert.doesNotMatch(videoAnnotation, /4 mins/);

  const redditContext = makeContext({
    reader_location: "All Locations"
  });
  redditContext.reader_location = "All Locations";
  vm.runInContext(
    `reader_location = "All Locations";`,
    redditContext
  );
  const redditDocument = {
    id: "reddit-doc",
    url: "https://read.readwise.io/feed/read/reddit-doc",
    source_url: "https://www.reddit.com/r/apple/comments/abc/a_post/",
    title: "A Reddit post",
    author: "u/example_user",
    category: "article",
    location: "feed",
    site_name: "Reddit",
    summary: "A post",
    parent_id: null,
    saved_at: "2026-08-29T10:00:00Z"
  };
  const redditIcons = await vm.runInContext(`resolveSiteIcons([${JSON.stringify(redditDocument)}])`, redditContext);
  const redditItem = vm.runInContext(
    `documentToItem(${JSON.stringify(redditDocument)}, ${JSON.stringify(redditIcons)})`,
    redditContext
  );
  assert.strictEqual(
    redditItem.author.avatar,
    "https://styles.redditmedia.com/profile/avatar.png?x=1&y=2"
  );
  assert.strictEqual(redditContext.iconLookupCount, undefined);

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
  const patchRequest = actionsContext._requests.find(request => request.method === "PATCH");
  assert.match(patchRequest.url, /\/api\/v3\/update\/doc-1\/$/);
  assert.deepStrictEqual(JSON.parse(patchRequest.parameters), { seen: true });
  assert.strictEqual(actionsContext.lastRequest.method, "PATCH");
  assert.ok(actionsContext.actionResult.actions.mark_unseen);
  assert.ok(!actionsContext.actionResult.actions.mark_seen);
  assert.doesNotMatch(actionsContext.actionResult.annotations[0].text, /Unseen in Reader/);

  vm.runInContext(
    `performAction("mark_unseen", actionResult.actions.mark_unseen, actionResult)`,
    actionsContext
  );
  await settle();
  assert.ifError(actionsContext.actionError);
  assert.ok(actionsContext.actionResult.actions.mark_seen);
  assert.match(actionsContext.actionResult.annotations[0].text, /Unseen in Reader/);

  const moveSequence = [
    ["move_later", "later"],
    ["move_archive", "archive"],
    ["move_inbox", "new"],
    ["move_feed", "feed"]
  ];
  for (const [actionId, expectedLocation] of moveSequence) {
    vm.runInContext(
      `performAction(${JSON.stringify(actionId)}, actionResult.actions[${JSON.stringify(actionId)}], actionResult)`,
      actionsContext
    );
    await settle();
    assert.ifError(actionsContext.actionError);
    assert.ok(!actionsContext.actionResult.actions[actionId]);
    const actionState = JSON.parse(Object.values(actionsContext.actionResult.actions)[0]);
    assert.strictEqual(actionState.location, expectedLocation);
  }

  const patchRequests = actionsContext._requests.filter(request => request.method === "PATCH");
  assert.strictEqual(patchRequests.length, 6);
  assert.deepStrictEqual(
    patchRequests.map(request => JSON.parse(request.parameters)),
    [{ seen: true }, { seen: false }, { location: "later" }, { location: "archive" }, { location: "new" }, { location: "feed" }]
  );
  assert.deepStrictEqual(
    actionDefinitions.items.map(action => action.id).sort(),
    ["mark_seen", "mark_unseen", "move_archive", "move_feed", "move_inbox", "move_later"].sort()
  );

  const allLocationActionsContext = makeContext({
    reader_location: "All Locations",
    enable_reader_actions: "on"
  });
  vm.runInContext("load()", allLocationActionsContext);
  await settle();
  assert.match(allLocationActionsContext.results[0].annotations[0].text, /Feed/);
  vm.runInContext(
    `performAction("move_later", results[0].actions.move_later, results[0])`,
    allLocationActionsContext
  );
  await settle();
  assert.ifError(allLocationActionsContext.actionError);
  assert.match(allLocationActionsContext.actionResult.annotations[0].text, /Later/);
  assert.doesNotMatch(allLocationActionsContext.actionResult.annotations[0].text, /Feed/);

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

  const badRequestContext = makeContext({
    enable_reader_actions: "on",
    sendRequest: async () => JSON.stringify({
      status: 400,
      headers: {},
      body: JSON.stringify({ detail: "Unsupported location." })
    })
  });
  badRequestContext.unchangedActions = { move_feed: "unchanged" };
  vm.runInContext(
    `performAction("move_feed", ${JSON.stringify(JSON.stringify({ id: "doc-1", location: "later", seen: false }))}, ({ actions: unchangedActions }))`,
    badRequestContext
  );
  await settle();
  assert.match(badRequestContext.actionError.message, /Unsupported location/);
  assert.strictEqual(badRequestContext.unchangedActions.move_feed, "unchanged");

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
