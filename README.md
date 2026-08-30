# Readwise Reader for Tapestry

A personal Tapestry connector that displays documents from your Readwise Reader
Feed, Inbox, Later, Shortlist, or Archive.

## Installation

1. Download `ReadwiseReader.tapestry` from this repository.
2. Open it on an iPhone or iPad with Tapestry installed, or use **Tapestry →
   Settings → Connectors → Add a Connector**.
3. Create a feed with the Readwise Reader connector.
4. Paste a personal Reader API token from <https://readwise.io/access_token>.

The token is entered during feed setup and is not included in the connector
bundle.

## Features

- All Locations, Feed, Inbox, Later, Shortlist, and Archive views
- Optional Article, Email, RSS, PDF, EPUB, Tweet, or Video filtering
- Summary or full-article display
- Open items in Reader or on the original website
- Original-site author icons, cached by domain with tiny-icon filtering
- Optional unseen-only initial import
- Native source cards with title, summary, author, site, and cover image
- Optional tag filtering by key or display name, plus an Untagged mode
- Optional Reader tag and note display
- Reading progress and word-count annotations
- Listening-time metadata for video and audio-oriented documents
- Reddit author avatars with subreddit and site-icon fallbacks
- Optional actions to mark documents seen/unseen or move them to Inbox, Later,
  Archive, or Feed
- Dedicated token verification and post-action state refresh
- Stable Reader document URLs derived from document IDs
- Incremental synchronization after the initial 25, 50, or 100-item import
- Lossless incremental pagination with configuration-aware checkpoints

The initial limit is not a permanent timeline limit. Later refreshes request
only new or updated Reader documents. Refreshes process up to 500 items at a
time and retain Reader's cursor when more remain, so the next refresh resumes
without advancing the synchronization window. A five-minute overlap protects
against delayed items; Tapestry deduplicates them by URL.

Reader actions are disabled by default. Turn on **Enable Reader Actions** for a
feed to allow Tapestry to change seen state and move that feed's documents
between Inbox, Later, and Archive. The connector sends only the selected change
to Reader's document update endpoint.

Tapestry does not expose a connector API for retracting an existing timeline
item. If a document is moved outside a location-specific feed, its older
timeline entry may remain visible. Use **All Locations** to keep receiving that
document's updated state after moves.

Tag names are resolved through Reader's Tag List API and cached for 24 hours.
The existing tag setting remains a text field because Tapestry connector
configuration does not support dynamic tag pickers.

## Development and tests

Open the directory containing `local.readwise.reader` as the Connectors Folder
in Tapestry Loom. Use Loom to verify the connector with a real token and to save
a fresh `.tapestry` bundle if you make changes.

Run the mocked tests and build the installable connector with:

```sh
node tests/plugin.test.js
bash scripts/build.sh
```

## Releases and versioning

Releases use semantic versioning from the `VERSION` file. Updating `VERSION`
on `main` builds the connector and creates a matching GitHub release (for
example, `1.0.1` creates `v1.0.1`) with `ReadwiseReader.tapestry` attached.
