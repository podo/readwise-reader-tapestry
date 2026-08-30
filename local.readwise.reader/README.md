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
- **Tag Filter** defaults to `All` (no filtering). Enter up to five
  comma-separated Reader tags to require all of them.
- **Metadata Detail** adds reading progress and word count in Rich mode.
- **Show Reader Tags** and **Show Reader Notes** control their timeline display.
- **Enable Reader Actions** adds seen/unseen and Inbox/Later/Archive/Feed actions.
- **Initial Item Limit** controls the first import. Later refreshes are incremental.

Tapestry uses each document's original-site icon as its author avatar when a
suitable icon is available. Icons are cached by site, and URLs that explicitly
advertise a tiny 16–48 pixel raster are ignored to avoid visibly soft avatars.
The cache refreshes icons after 30 days.

Incremental synchronization retains Reader's pagination cursor when a large
update cannot be completed in one refresh. Changing a feed filter starts a new
initial import for that configuration instead of reusing an incompatible sync
timestamp.

Reader actions are disabled by default. When enabled, only selecting an explicit
action sends a document update to Reader; merely viewing an item in Tapestry
does not change it.

After an action, the connector retrieves the document again so its actions and
seen state reflect the location Reader actually selected.

Reader's document API is limited to 20 requests per minute. This connector uses
at most five pages during one incremental refresh and includes a small overlap
between refresh windows so delayed documents are not missed.
