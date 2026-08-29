// local.readwise.reader

const apiBase = "https://readwise.io/api/v3/list/";
const syncKey = "lastSuccessfulSync";
const overlapMilliseconds = 5 * 60 * 1000;
const maximumIncrementalPages = 5;
const siteIconCacheKey = "siteIconCacheV1";
const siteIconCacheLimit = 200;
const siteIconLookupConcurrency = 4;

function verify() {
  verifyAsync().then(processVerification).catch(processError);
}

function load() {
  loadAsync().then(processResults).catch(processError);
}

async function verifyAsync() {
  validateToken();

  const query = buildQuery(null, 1, false);
  const response = await readerRequest(`${apiBase}?${query}`);
  parseDocumentResponse(response);

  return {
    displayName: `Reader · ${normalizedLocationLabel()}`,
    icon: "https://readwise.io/favicon.ico"
  };
}

async function loadAsync() {
  validateToken();

  const requestStartedAt = new Date();
  const lastSync = getItem(syncKey);
  const isInitialImport = !lastSync;
  const limit = normalizedBatchSize();
  const includeFullContent = normalizedChoice(content_detail) === "full article";
  const documents = [];

  let pageCursor = null;
  let pageCount = 0;

  do {
    const query = buildQuery(lastSync, limit, includeFullContent, pageCursor);
    const response = await readerRequest(`${apiBase}?${query}`);
    const page = parseDocumentResponse(response);

    for (const document of page.results) {
      if (isTopLevelDocument(document) && shouldIncludeDocument(document)) {
        documents.push(document);
      }
    }

    pageCursor = page.nextPageCursor || null;
    pageCount += 1;

    // The initial import intentionally takes only the newest configured batch.
    // Incremental refreshes paginate to avoid dropping bursts of new content.
  } while (!isInitialImport && pageCursor && pageCount < maximumIncrementalPages);

  const siteIcons = await resolveSiteIcons(documents);
  const nextSync = new Date(requestStartedAt.getTime() - overlapMilliseconds);
  setItem(syncKey, nextSync.toISOString());

  return documents.map(document => documentToItem(document, siteIcons));
}

function readerRequest(url) {
  const headers = {
    "Authorization": `Token ${api_token.trim()}`,
    "Accept": "application/json"
  };
  return sendRequest(url, "GET", null, headers);
}

function buildQuery(updatedAfter, limit, includeFullContent, pageCursor) {
  const pairs = [
    ["location", normalizedLocation()],
    ["limit", String(limit)],
    ["withHtmlContent", includeFullContent ? "true" : "false"]
  ];

  const category = normalizedCategory();
  if (category) pairs.push(["category", category]);
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
  const readerUrl = document.url || `https://read.readwise.io/read/${encodeURIComponent(document.id)}`;
  const originalUrl = document.source_url || readerUrl;
  const openOriginal = normalizedChoice(open_target) === "original website";
  const uri = openOriginal ? originalUrl : readerUrl;
  const item = Item.createWithUriDate(uri, documentDate(document));

  if (document.title) item.title = document.title;
  item.body = documentBody(document, originalUrl);

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

  const annotationParts = [];
  if (document.category) annotationParts.push(displayCategory(document.category));
  if (document.reading_time) annotationParts.push(document.reading_time);
  if (!document.first_opened_at) annotationParts.push("Unseen in Reader");
  if (annotationParts.length > 0) {
    item.annotations = [Annotation.createWithText(annotationParts.join(" · "))];
  }

  return item;
}

async function resolveSiteIcons(documents) {
  const cache = readSiteIconCache();
  const pagesByOrigin = {};

  for (const document of documents) {
    const origin = normalizedWebOrigin(document.source_url);
    if (origin && !Object.prototype.hasOwnProperty.call(cache, origin)) {
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
    if (entry && entry.url) icons[origin] = entry.url;
  }
  return icons;
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

  if (document.image_url && (!wantsFullContent || !document.html_content)) {
    body += `<p><img src="${escapeAttribute(document.image_url)}" /></p>`;
  }

  if (wantsFullContent && document.html_content) {
    body += document.html_content;
  }
  else if (document.summary) {
    body += `<p>${escapeHtml(document.summary)}</p>`;
  }
  else {
    body += "<p>No summary is available. Open the document to read it.</p>";
  }

  if (originalUrl) {
    body += `<p><a href="${escapeAttribute(originalUrl)}">Open original</a></p>`;
  }

  return body;
}

function documentDate(document) {
  const candidates = [
    document.saved_at,
    document.created_at,
    document.updated_at,
    document.published_date
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return new Date();
}

function isTopLevelDocument(document) {
  return document && document.id && !document.parent_id;
}

function shouldIncludeDocument(document) {
  if (only_unseen === "on" && document.first_opened_at) return false;
  return true;
}

function validateToken() {
  if (typeof api_token !== "string" || !api_token.trim()) {
    throw new Error("Enter a Reader API token from readwise.io/access_token.");
  }
}

function normalizedLocation() {
  const value = normalizedChoice(reader_location);
  if (value === "inbox") return "new";
  if (["feed", "later", "shortlist", "archive"].includes(value)) return value;
  return "feed";
}

function normalizedLocationLabel() {
  const value = normalizedChoice(reader_location);
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "Feed";
}

function normalizedCategory() {
  const value = normalizedChoice(document_category);
  return value === "all" ? null : value;
}

function normalizedBatchSize() {
  const value = parseInt(batch_size, 10);
  return [25, 50, 100].includes(value) ? value : 50;
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
