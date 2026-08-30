// local.readwise.reader

const apiBase = "https://readwise.io/api/v3/list/";
const updateApiBase = "https://readwise.io/api/v3/update/";
const authApiUrl = "https://readwise.io/api/v2/auth/";
const tagApiBase = "https://readwise.io/api/v3/tags/";
const syncStateKey = "syncStateV2";
const overlapMilliseconds = 5 * 60 * 1000;
const maximumIncrementalPages = 5;
const siteIconCacheKey = "documentAvatarCacheV2";
const siteIconCacheLimit = 200;
const siteIconLookupConcurrency = 4;
const siteIconCacheTtlMilliseconds = 30 * 24 * 60 * 60 * 1000;
const tagCacheKey = "readerTagCacheV1";
const tagCacheTtlMilliseconds = 24 * 60 * 60 * 1000;
const maximumTagPages = 5;
const maximumCachedTags = 500;

function verify() {
  verifyAsync().then(processVerification).catch(processError);
}

function load() {
  loadAsync().then(processResults).catch(processError);
}

function performAction(actionId, actionValue, item) {
  performReaderAction(actionId, actionValue, item)
    .then(updatedItem => actionComplete(updatedItem, null))
    .catch(error => actionComplete(null, error));
}

async function verifyAsync() {
  validateToken();
  await readerApiRequest(authApiUrl, "GET", null);
  await resolvedRequiredTagKeys();

  return {
    displayName: `Reader · ${normalizedLocationLabel()}`,
    icon: "https://readwise.io/favicon.ico"
  };
}

async function loadAsync() {
  validateToken();

  const requestStartedAt = new Date();
  const signature = currentSyncSignature();
  let syncState = readSyncState();
  if (syncState.signature !== signature) {
    syncState = newSyncState(signature);
  }

  const isInitialImport = !syncState.updatedAfter && !syncState.pageCursor;
  const windowStartedAt = syncState.windowStartedAt || requestStartedAt.toISOString();
  const limit = normalizedBatchSize();
  const includeFullContent = normalizedChoice(content_detail) === "full article";
  const requiredTagKeys = await resolvedRequiredTagKeys();
  const documents = [];

  let pageCursor = syncState.pageCursor || null;
  let pageCount = 0;

  do {
    const query = buildQuery(syncState.updatedAfter, limit, includeFullContent, pageCursor, requiredTagKeys);
    const response = await readerRequest(`${apiBase}?${query}`);
    const page = parseDocumentResponse(response);

    for (const document of page.results) {
      if (isTopLevelDocument(document) && !document.is_deleted && shouldIncludeDocument(document)) {
        documents.push(document);
      }
    }

    pageCursor = page.nextPageCursor || null;
    pageCount += 1;

    // The initial import intentionally takes only the newest configured batch.
    // Incremental refreshes paginate to avoid dropping bursts of new content.
  } while (!isInitialImport && pageCursor && pageCount < maximumIncrementalPages);

  const siteIcons = await resolveSiteIcons(documents);
  if (!isInitialImport && pageCursor) {
    writeSyncState({
      signature,
      updatedAfter: syncState.updatedAfter,
      pageCursor,
      windowStartedAt
    });
  }
  else {
    const completedWindow = new Date(windowStartedAt);
    const nextSync = new Date(completedWindow.getTime() - overlapMilliseconds);
    writeSyncState({
      signature,
      updatedAfter: nextSync.toISOString(),
      pageCursor: null,
      windowStartedAt: null
    });
  }

  return documents.map(document => documentToItem(document, siteIcons));
}

async function readerRequest(url) {
  const response = await readerApiRequest(url, "GET", null);
  return response.body;
}

async function readerApiRequest(url, method, parameters) {
  const headers = {
    "Authorization": `Token ${api_token.trim()}`,
    "Accept": "application/json"
  };
  if (parameters != null) headers["Content-Type"] = "application/json";

  let text;
  try {
    text = await sendRequest(url, method, parameters, headers, true);
  }
  catch (error) {
    throw normalizedReaderError(error);
  }

  try {
    const response = JSON.parse(text);
    if (response && typeof response.status === "number" && Object.prototype.hasOwnProperty.call(response, "body")) {
      if (response.status >= 400) throw readerStatusError(response.status, response.headers, response.body);
      return {
        status: response.status,
        headers: response.headers || {},
        body: typeof response.body === "string" ? response.body : JSON.stringify(response.body)
      };
    }
  }
  catch (error) {
    if (error && error.readerApiError) throw error;
  }

  return { status: 200, headers: {}, body: text };
}

async function readerUpdate(documentId, changes) {
  return readerApiRequest(
    `${updateApiBase}${encodeURIComponent(documentId)}/`,
    "PATCH",
    JSON.stringify(changes)
  );
}

async function performReaderAction(actionId, actionValue, item) {
  if (enable_reader_actions !== "on") {
    throw new Error("Reader actions are disabled for this feed.");
  }

  let state;
  try {
    state = JSON.parse(actionValue);
  }
  catch (error) {
    throw new Error("This item has invalid Reader action data.");
  }
  if (!state || !state.id) throw new Error("This item is missing its Reader document ID.");

  const changes = actionChanges(actionId);
  if (!changes) throw new Error(`Unknown Reader action: ${actionId}`);
  await readerUpdate(state.id, changes);

  const nextLocation = changes.location || state.location;
  const nextSeen = typeof changes.seen === "boolean" ? changes.seen : Boolean(state.seen);
  item.annotations = actionAnnotations(item.annotations, state.location, nextLocation, nextSeen);
  item.actions = readerActions(state.id, nextLocation, nextSeen);
  return item;
}

function actionAnnotations(annotations, previousLocation, nextLocation, seen) {
  const current = annotations ? Array.from(annotations) : [];
  const first = current[0];
  let details = first && first.text
    ? String(first.text).split(" · ").filter(Boolean)
    : [];

  details = details.filter(detail => detail !== "Unseen in Reader");
  if (!normalizedLocation() && previousLocation && nextLocation) {
    const previousLabel = displayLocation(previousLocation);
    const nextLabel = displayLocation(nextLocation);
    const locationIndex = details.indexOf(previousLabel);
    if (locationIndex >= 0) details[locationIndex] = nextLabel;
  }
  if (!seen) details.push("Unseen in Reader");

  if (details.length > 0) {
    current[0] = Annotation.createWithText(details.join(" · "));
  }
  else if (current.length > 0) {
    current.shift();
  }
  return current.length > 0 ? current : undefined;
}

function actionChanges(actionId) {
  if (actionId === "mark_seen") return { seen: true };
  if (actionId === "mark_unseen") return { seen: false };
  if (actionId === "move_later") return { location: "later" };
  if (actionId === "move_archive") return { location: "archive" };
  if (actionId === "move_inbox") return { location: "new" };
  if (actionId === "move_feed") return { location: "feed" };
  return null;
}

function readerStatusError(status, headers, body) {
  let message = `Reader returned HTTP ${status}.`;
  if (status === 401 || status === 403) {
    message = "Reader rejected the API token. Create a fresh token at readwise.io/access_token.";
  }
  else if (status === 429) {
    const retryAfter = headerValue(headers, "retry-after");
    message = retryAfter
      ? `Reader rate limit reached. Try again in ${retryAfter} seconds.`
      : "Reader rate limit reached. Try again shortly.";
  }
  else {
    const detail = readerErrorDetail(body);
    if (detail) message += ` ${detail}`;
  }

  const error = new Error(message);
  error.readerApiError = true;
  return error;
}

function readerErrorDetail(body) {
  if (body == null) return null;
  if (typeof body === "object") return body.detail || body.error || body.message || null;
  if (typeof body !== "string" || !body.trim()) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed.detail || parsed.error || parsed.message || null;
  }
  catch (error) {
    return body.length <= 200 ? body : null;
  }
}

function normalizedReaderError(error) {
  const message = error && error.message ? error.message : String(error);
  if (/\b(401|403)\b/.test(message)) return readerStatusError(401);
  if (/\b429\b/.test(message)) return readerStatusError(429);
  return error instanceof Error ? error : new Error(message);
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : null;
}

function buildQuery(updatedAfter, limit, includeFullContent, pageCursor, requiredTagKeys) {
  const pairs = [
    ["limit", String(limit)],
    ["withHtmlContent", includeFullContent ? "true" : "false"]
  ];

  const location = normalizedLocation();
  if (location) pairs.push(["location", location]);
  const category = normalizedCategory();
  if (category) pairs.push(["category", category]);
  for (const tag of requiredTagKeys || []) pairs.push(["tag", tag]);
  if (updatedAfter) pairs.push(["updatedAfter", updatedAfter]);
  if (pageCursor) pairs.push(["pageCursor", pageCursor]);

  return pairs
    .map(pair => `${encodeURIComponent(pair[0])}=${encodeURIComponent(pair[1])}`)
    .join("&");
}

function parseDocumentResponse(text) {
  const json = JSON.parse(text);
  if (!json || !Array.isArray(json.results)) {
    throw new Error("Reader returned an unexpected document response.");
  }
  return json;
}

function documentToItem(document, siteIcons) {
  const readerUrl = stableReaderDocumentUrl(document);
  const originalUrl = document.source_url || readerUrl;
  const openOriginal = normalizedChoice(open_target) === "original website";
  const uri = openOriginal ? originalUrl : readerUrl;
  const item = Item.createWithUriDate(uri, documentDate(document));

  if (document.title) item.title = document.title;
  item.body = documentBody(document);

  const linkAttachment = documentLinkAttachment(document, originalUrl);
  if (linkAttachment) item.attachments = [linkAttachment];

  const identityName = document.site_name || document.author || "Readwise Reader";
  const identity = Identity.createWithName(identityName);
  identity.uri = originalUrl;
  const siteOrigin = documentAvatarCacheKey(document);
  const siteIcon = siteOrigin && siteIcons ? siteIcons[siteOrigin] : null;
  if (siteIcon) identity.avatar = siteIcon;
  if (document.author && document.author !== identityName) {
    identity.username = document.author;
  }
  item.author = identity;

  item.annotations = documentAnnotations(document);
  if (enable_reader_actions === "on") {
    item.actions = readerActions(document.id, document.location, documentSeen(document));
  }

  return item;
}

function stableReaderDocumentUrl(document) {
  if (document && document.id) {
    return `https://read.readwise.io/read/${encodeURIComponent(document.id)}`;
  }
  return document && document.url ? document.url : "https://read.readwise.io";
}

async function resolveSiteIcons(documents) {
  const cache = readSiteIconCache();
  const pagesByOrigin = {};

  for (const document of documents) {
    const origin = documentAvatarCacheKey(document);
    if (origin && !isCurrentSiteIconEntry(cache[origin])) {
      pagesByOrigin[origin] = document;
    }
  }

  const queue = Object.entries(pagesByOrigin);
  const workerCount = Math.min(siteIconLookupConcurrency, queue.length);
  const workers = [];

  for (let index = 0; index < workerCount; index += 1) {
    workers.push((async () => {
      while (queue.length > 0) {
        const [origin, document] = queue.shift();
        let icon = null;

        try {
          const candidate = await lookupDocumentAvatar(document);
          if (isAcceptableSiteIcon(candidate)) icon = candidate;
        }
        catch (error) {
          // A missing or unreachable icon must never prevent timeline loading.
        }

        cache[origin] = {
          url: icon,
          checkedAt: new Date().toISOString()
        };
      }
    })());
  }

  await Promise.all(workers);
  writeSiteIconCache(cache);

  const icons = {};
  for (const [origin, entry] of Object.entries(cache)) {
    if (isCurrentSiteIconEntry(entry) && entry.url) icons[origin] = entry.url;
  }
  return icons;
}

function documentAvatarCacheKey(document) {
  const reddit = redditDocumentContext(document);
  if (reddit && reddit.author) return `reddit:user:${reddit.author.toLowerCase()}`;
  if (reddit && reddit.subreddit) return `reddit:subreddit:${reddit.subreddit.toLowerCase()}`;
  return normalizedWebOrigin(document && document.source_url);
}

async function lookupDocumentAvatar(document) {
  const reddit = redditDocumentContext(document);
  if (reddit) {
    if (reddit.author) {
      const profile = await redditAbout(`https://www.reddit.com/user/${encodeURIComponent(reddit.author)}/about.json?raw_json=1`);
      const profileIcon = profile && (profile.snoovatar_img || profile.icon_img);
      if (profileIcon) return decodeHtmlUrl(profileIcon);
    }
    if (reddit.subreddit) {
      const community = await redditAbout(`https://www.reddit.com/r/${encodeURIComponent(reddit.subreddit)}/about.json?raw_json=1`);
      const communityIcon = community && (community.community_icon || community.icon_img);
      if (communityIcon) return decodeHtmlUrl(communityIcon);
    }
  }
  return lookupIcon(document.source_url);
}

async function redditAbout(url) {
  try {
    const text = await sendRequest(url, "GET", null, {
      "User-Agent": "Tapestry Readwise Reader connector"
    });
    const parsed = JSON.parse(text);
    return parsed && parsed.data ? parsed.data : null;
  }
  catch (error) {
    return null;
  }
}

function redditDocumentContext(document) {
  if (!document || !document.source_url) return null;
  try {
    const url = new URL(document.source_url);
    if (!/(^|\.)reddit\.com$/i.test(url.hostname)) return null;
    const subredditMatch = url.pathname.match(/^\/r\/([^/]+)/i);
    let author = typeof document.author === "string" ? document.author.trim() : "";
    author = author.replace(/^u\//i, "").replace(/^@/, "");
    if (!author || author === "[deleted]" || /\s/.test(author)) author = null;
    return {
      author,
      subreddit: subredditMatch ? decodeURIComponent(subredditMatch[1]) : null
    };
  }
  catch (error) {
    return null;
  }
}

function decodeHtmlUrl(value) {
  return String(value).replace(/&amp;/g, "&");
}

function isCurrentSiteIconEntry(entry) {
  if (!entry || !entry.checkedAt) return false;
  const checkedAt = new Date(entry.checkedAt);
  return !Number.isNaN(checkedAt.getTime())
    && Date.now() - checkedAt.getTime() < siteIconCacheTtlMilliseconds;
}

function normalizedWebOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  }
  catch (error) {
    return null;
  }
}

function isAcceptableSiteIcon(value) {
  if (typeof value !== "string" || !value.trim()) return false;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "data:") {
      return false;
    }
  }
  catch (error) {
    return false;
  }

  // Reject icons whose URL explicitly advertises a raster size too small for
  // a Retina avatar. Unknown and multi-resolution ICO sizes are left to
  // Tapestry's native icon resolver.
  const lower = value.toLowerCase();
  return !/(?:^|[^0-9])(16|24|32|48)(?:x\1)?(?:[^0-9]|$)/.test(lower);
}

function readSiteIconCache() {
  const stored = getItem(siteIconCacheKey);
  if (!stored) return {};

  try {
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }
  catch (error) {
    return {};
  }
}

function writeSiteIconCache(cache) {
  const entries = Object.entries(cache)
    .sort((left, right) => String(right[1].checkedAt).localeCompare(String(left[1].checkedAt)))
    .slice(0, siteIconCacheLimit);
  setItem(siteIconCacheKey, JSON.stringify(Object.fromEntries(entries)));
}

function documentBody(document) {
  const wantsFullContent = normalizedChoice(content_detail) === "full article";
  let body = "";

  if (wantsFullContent && document.html_content) {
    body += document.html_content;
  }
  else if (document.summary) {
    body += `<p>${escapeHtml(document.summary)}</p>`;
  }
  else {
    body += "<p>No summary is available. Open the document to read it.</p>";
  }

  if (show_notes === "on" && document.notes) {
    body += `<blockquote><strong>Reader note:</strong> ${escapeHtml(document.notes)}</blockquote>`;
  }

  return body;
}

function documentLinkAttachment(document, originalUrl) {
  if (!normalizedWebOrigin(originalUrl)) return null;

  const attachment = LinkAttachment.createWithUrl(originalUrl);
  if (document.title) attachment.title = document.title;
  if (document.summary) attachment.subtitle = document.summary;
  if (document.site_name) attachment.siteName = document.site_name;
  if (document.author) attachment.authorName = document.author;
  if (document.image_url) attachment.image = document.image_url;
  attachment.type = linkTypeForCategory(document.category);
  return attachment;
}

function documentAnnotations(document) {
  const annotations = [];
  const details = [];

  if (document.category) details.push(displayCategory(document.category));
  if (!normalizedLocation() && document.location) details.push(displayLocation(document.location));
  if (document.category === "video" && document.listening_time) details.push(document.listening_time);
  else if (document.reading_time) details.push(document.reading_time);
  else if (document.listening_time) details.push(document.listening_time);
  if (normalizedChoice(metadata_detail) === "rich") {
    const progress = formattedProgress(document.reading_progress);
    if (progress) details.push(progress);
    const wordCount = formattedWordCount(document.word_count);
    if (wordCount) details.push(wordCount);
  }
  if (!documentSeen(document)) details.push("Unseen in Reader");
  if (details.length > 0) annotations.push(Annotation.createWithText(details.join(" · ")));

  const tags = documentTagNames(document.tags);
  if (show_tags === "on" && tags.length > 0) {
    annotations.push(Annotation.createWithText(`Tags: ${tags.join(", ")}`));
  }

  return annotations.length > 0 ? annotations : undefined;
}

function readerActions(id, location, seen) {
  const value = JSON.stringify({ id, location: location || normalizedLocation(), seen: Boolean(seen) });
  const actions = {};
  actions[seen ? "mark_unseen" : "mark_seen"] = value;
  if (location !== "later") actions.move_later = value;
  if (location !== "archive") actions.move_archive = value;
  if (location !== "new") actions.move_inbox = value;
  if (location !== "feed") actions.move_feed = value;
  return actions;
}

function documentTagNames(tags) {
  if (Array.isArray(tags)) {
    return tags.map(tag => typeof tag === "string" ? tag : tag && (tag.name || tag.key))
      .filter(Boolean);
  }
  if (tags && typeof tags === "object") {
    return Object.entries(tags).map(([key, value]) => {
      if (typeof value === "string") return value;
      if (value && typeof value === "object") return value.name || key;
      return key;
    }).filter(Boolean);
  }
  return [];
}

function formattedProgress(value) {
  const progress = Number(value);
  if (!Number.isFinite(progress) || progress <= 0) return null;
  return `${Math.min(100, Math.round(progress * 100))}% read`;
}

function formattedWordCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return null;
  return `${Math.round(count).toLocaleString("en-US")} words`;
}

function linkTypeForCategory(category) {
  const value = normalizedChoice(category);
  if (value === "video") return "video.other";
  if (value === "epub") return "book";
  return "article";
}

function documentDate(document) {
  const candidates = document.location === "feed"
    ? [document.published_date, document.created_at, document.saved_at, document.updated_at]
    : [document.saved_at, document.created_at, document.published_date, document.updated_at];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return new Date();
}

function currentSyncSignature() {
  return JSON.stringify({
    location: normalizedLocation(),
    category: normalizedCategory(),
    content: normalizedChoice(content_detail),
    target: normalizedChoice(open_target),
    unseen: only_unseen === "on",
    batchSize: normalizedBatchSize(),
    tags: normalizedRequiredTags(),
    showTags: show_tags === "on",
    showNotes: show_notes === "on",
    metadata: normalizedChoice(metadata_detail),
    actions: enable_reader_actions === "on"
  });
}

function newSyncState(signature) {
  return {
    signature,
    updatedAfter: null,
    pageCursor: null,
    windowStartedAt: null
  };
}

function readSyncState() {
  const stored = getItem(syncStateKey);
  if (!stored) return newSyncState(null);

  try {
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === "object" ? parsed : newSyncState(null);
  }
  catch (error) {
    return newSyncState(null);
  }
}

function writeSyncState(state) {
  setItem(syncStateKey, JSON.stringify(state));
}

function isTopLevelDocument(document) {
  return document && document.id && !document.parent_id;
}

function shouldIncludeDocument(document) {
  if (only_unseen === "on" && documentSeen(document)) return false;
  return true;
}

function documentSeen(document) {
  return typeof document.seen === "boolean" ? document.seen : Boolean(document.first_opened_at);
}

function validateToken() {
  if (typeof api_token !== "string" || !api_token.trim()) {
    throw new Error("Enter a Reader API token from readwise.io/access_token.");
  }
}

function normalizedLocation() {
  const value = normalizedChoice(reader_location);
  if (value === "all locations") return null;
  if (value === "inbox") return "new";
  if (["feed", "later", "shortlist", "archive"].includes(value)) return value;
  return "feed";
}

function normalizedLocationLabel() {
  const value = normalizedChoice(reader_location);
  if (value === "all locations") return "All Locations";
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "Feed";
}

function displayLocation(location) {
  const value = normalizedChoice(location);
  if (value === "new") return "Inbox";
  if (!value) return "Unknown location";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizedCategory() {
  const value = normalizedChoice(document_category);
  return value === "all" ? null : value;
}

function normalizedBatchSize() {
  const value = parseInt(batch_size, 10);
  return [25, 50, 100].includes(value) ? value : 50;
}

function normalizedRequiredTags() {
  if (typeof required_tags !== "string") return [];
  const value = required_tags.trim();
  if (!value || normalizedChoice(value) === "all") return [];
  return value.split(",").map(tag => tag.trim()).filter(Boolean).slice(0, 5);
}

async function resolvedRequiredTagKeys() {
  const requested = normalizedRequiredTags();
  if (requested.length === 0) return [];

  const untagged = requested.filter(value => normalizedChoice(value) === "untagged");
  if (untagged.length > 0) {
    if (requested.length !== 1) throw new Error("Untagged cannot be combined with other tag filters.");
    return [""];
  }

  let catalog = await readerTagCatalog(false);
  let resolved = resolveTagInputs(requested, catalog.tags);
  if (resolved.missing.length > 0 && catalog.fromCache) {
    catalog = await readerTagCatalog(true);
    resolved = resolveTagInputs(requested, catalog.tags);
  }

  if (resolved.ambiguous.length > 0) {
    throw new Error(`Reader tag name is ambiguous: ${resolved.ambiguous.join(", ")}. Enter its tag key instead.`);
  }
  if (resolved.missing.length > 0) {
    const suffix = catalog.complete ? "" : " within the first five Reader tag pages";
    throw new Error(`Reader tag not found${suffix}: ${resolved.missing.join(", ")}.`);
  }
  return resolved.keys;
}

function resolveTagInputs(requested, tags) {
  const keys = [];
  const missing = [];
  const ambiguous = [];

  for (const input of requested) {
    const normalized = normalizedChoice(input);
    const keyMatches = tags.filter(tag => normalizedChoice(tag.key) === normalized);
    if (keyMatches.length === 1) {
      keys.push(keyMatches[0].key);
      continue;
    }

    const nameMatches = tags.filter(tag => normalizedChoice(tag.name) === normalized);
    if (nameMatches.length === 1) keys.push(nameMatches[0].key);
    else if (nameMatches.length > 1) ambiguous.push(input);
    else missing.push(input);
  }

  return { keys, missing, ambiguous };
}

async function readerTagCatalog(forceRefresh) {
  if (!forceRefresh) {
    const cached = readTagCache();
    if (cached) return { tags: cached.tags, complete: cached.complete, fromCache: true };
  }

  const tags = [];
  let cursor = null;
  let pageCount = 0;
  do {
    const url = cursor
      ? `${tagApiBase}?pageCursor=${encodeURIComponent(cursor)}`
      : tagApiBase;
    const response = await readerRequest(url);
    const page = JSON.parse(response);
    if (!page || !Array.isArray(page.results)) throw new Error("Reader returned an unexpected tag response.");
    for (const tag of page.results) {
      if (tag && tag.key) tags.push({ key: String(tag.key), name: String(tag.name || tag.key) });
    }
    cursor = page.nextPageCursor || null;
    pageCount += 1;
  } while (cursor && pageCount < maximumTagPages);

  writeTagCache(tags, !cursor);
  return { tags, complete: !cursor, fromCache: false };
}

function readTagCache() {
  const stored = getItem(tagCacheKey);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    const fetchedAt = new Date(parsed.fetchedAt);
    if (!Array.isArray(parsed.tags) || Number.isNaN(fetchedAt.getTime())) return null;
    if (Date.now() - fetchedAt.getTime() >= tagCacheTtlMilliseconds) return null;
    return parsed;
  }
  catch (error) {
    return null;
  }
}

function writeTagCache(tags, complete) {
  const compact = {
    fetchedAt: new Date().toISOString(),
    complete: Boolean(complete),
    tags: tags.slice(0, maximumCachedTags)
  };
  setItem(tagCacheKey, JSON.stringify(compact));
}

function normalizedChoice(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function displayCategory(category) {
  const value = String(category).toUpperCase();
  if (value === "RSS" || value === "PDF" || value === "EPUB") return value;
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
