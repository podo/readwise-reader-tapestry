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

- Reader Feed, Inbox, Later, Shortlist, and Archive locations
- Optional Article, Email, RSS, PDF, EPUB, Tweet, or Video filtering
- Summary or full-article display
- Open items in Reader or on the original website
- Original-site author icons, cached by domain with tiny-icon filtering
- Optional unseen-only initial import
- Incremental synchronization after the initial 25, 50, or 100-item import

The initial limit is not a permanent timeline limit. Later refreshes request
only new or updated Reader documents and can paginate through up to 500 items
per refresh. A five-minute overlap protects against delayed items; Tapestry
deduplicates them by URL.

The connector is read-only. It never changes seen state or document location in
Reader.

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
