// local.readwise.reader

const apiBase = "https://readwise.io/api/v3/list/";
const updateApiBase = "https://readwise.io/api/v3/update/";
const authApiUrl = "https://readwise.io/api/v2/auth/";
const syncStateKey = "syncStateV2";
const overlapMilliseconds = 5 * 60 * 1000;
const maximumIncrementalPages = 5;
const siteIconCacheKey = "siteIconCacheV1";
const siteIconCacheLimit = 200;
const siteIconLookupConcurrency = 4;
const siteIconCacheTtlMilliseconds = 30 * 24 * 60 * 60 * 1000;

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
  const documents = [];

  let pageCursor = syncState.pageCursor || null;
  let pageCount = 0;

  do {
    const query = buildQuery(syncState.updatedAfter, limit, includeFullContent, pageCursor);
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

async function readerDocumentById(documentId) {
  const pairs = [
    ["id", documentId],
    ["withHtmlContent", normalizedChoice(content_detail) === "full article" ? "true" : "false"]
  ];
  const query = pairs.map(pair => `${encodeURIComponent(pair[0])}=${encodeURIComponent(pair[1])}`).join("&");
  const response = await readerRequest(`${apiBase}?${query}`);
  const page = parseDocumentResponse(response);
  const document = page.results.find(result => result && result.id === documentId);
  if (!document) throw new Error("Reader did not return the updated document.");
  return document;
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
  const document = await readerDocumentById(state.id);

  item.annotations = documentAnnotations(document);
  item.actions = readerActions(document.id, document.location, documentSeen(document));
  return item;
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

function buildQuery(updatedAfter, limit, includeFullContent, pageCursor) {
  const pairs = [
    ["limit", String(limit)],
    ["withHtmlContent", includeFullContent ? "true" : "false"]
  ];

  const location = normalizedLocation();
  if (location) pairs.push(["location", location]);
  const category = normalizedCategory();
  if (category) pairs.push(["category", category]);
  for (const tag of normalizedRequiredTags()) pairs.push(["tag", tag]);
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
  item.body = documentBody(document, originalUrl);

  const linkAttachment = documentLinkAttachment(document, originalUrl);
  if (linkAttachment) item.attachments = [linkAttachment];

  const identityName = document.site_name || document.author || "Readwise Reader";
  const identity = Identity.createWithName(identityName);
  identity.uri = originalUrl;
  const siteOrigin = normalizedWebOrigin(document.source_url);
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
    const origin = normalizedWebOrigin(document.source_url);
    if (origin && !isCurrentSiteIconEntry(cache[origin])) {
      pagesByOrigin[origin] = document.source_url;
    }
  }

  const queue = Object.entries(pagesByOrigin);
  const workerCount = Math.min(siteIconLookupConcurrency, queue.length);
  const workers = [];

  for (let index = 0; index < workerCount; index += 1) {
    workers.push((async () => {
      while (queue.length > 0) {
        const [origin, pageUrl] = queue.shift();
        let icon = null;

        try {
          const candidate = await lookupIcon(pageUrl);
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

function documentBody(document, originalUrl) {
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

  if (originalUrl) {
    body += `<p><a href="${escapeAttribute(originalUrl)}">Open original</a></p>`;
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
  if (document.reading_time) details.push(document.reading_time);
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
  if (tags && typeof tags === "object") return Object.values(tags).filter(Boolean).map(String);
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
