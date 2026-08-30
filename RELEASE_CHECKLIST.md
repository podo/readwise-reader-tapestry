# Release checklist

Automated tests are necessary but do not exercise Tapestry's native JavaScript
bridge. Before tagging a release, validate the connector in Tapestry Loom, which
uses the same processing pipeline as the app.

## Automated

- Run `node tests/plugin.test.js`.
- Run `bash scripts/build.sh` and validate the archive.
- Confirm JSON configuration files parse successfully.

## Tapestry Loom

- Verify a valid token and confirm invalid/expired tokens show a useful error.
- Load Summary and Full Article modes.
- Check Reader and Original Website opening targets.
- Check All Locations, Feed, Inbox, Later, Shortlist, and Archive locations.
- Confirm the location-free Reader URL opens the same document after moves.
- Check tag filter values `All`, a real tag key/name, and `Untagged` when supported.
- Confirm source LinkAttachment and full-content media do not duplicate.
- Confirm a Reddit post shows its author avatar, with subreddit/site fallbacks.
- With actions enabled, test seen/unseen and every supported move action.
- Confirm PATCH bodies and headers reach Reader correctly.
- Confirm action failures leave the original item unchanged.
- Confirm moving a document does not create a duplicate timeline item.

## Device

- Install the Loom-saved `.tapestry` connector on iPhone or iPad.
- Open Reader and original-site links.
- Repeat at least one seen action and one move action.
