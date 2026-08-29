# Readwise Reader

Display documents from your personal Readwise Reader account in Tapestry.

## Setup

1. Generate a personal token at [readwise.io/access_token](https://readwise.io/access_token).
2. In Tapestry, create a feed using this connector.
3. Paste the token into **Reader API Token**.
4. Choose the Reader location and content options you want.

Your token is sent only to `https://readwise.io` as an API authorization
header. It is not included in the connector bundle.

## Options

- **Reader Location** selects Feed, Inbox, Later, Shortlist, or Archive.
- **Content Type** optionally limits the timeline to one Reader category.
- **Item Content** uses either Reader's compact summary or its parsed article HTML.
- **Open Items In** opens either the Reader document or its original website.
- **Import Only Unseen** filters out documents already opened in Reader at import time.
- **Initial Item Limit** controls the first import. Later refreshes are incremental.

Tapestry uses each document's original-site icon as its author avatar when a
suitable icon is available. Icons are cached by site, and URLs that explicitly
advertise a tiny 16–48 pixel raster are ignored to avoid visibly soft avatars.
The cache refreshes icons after 30 days.

Incremental synchronization retains Reader's pagination cursor when a large
update cannot be completed in one refresh. Changing a feed filter starts a new
initial import for that configuration instead of reusing an incompatible sync
timestamp.

The connector is intentionally read-only. Reading or saving an item in Tapestry
does not mark it seen, move it, archive it, or otherwise modify Reader.

Reader's document API is limited to 20 requests per minute. This connector uses
at most five pages during one incremental refresh and includes a small overlap
between refresh windows so delayed documents are not missed.
