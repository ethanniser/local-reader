# Library sync backend

Deploy this to your own Convex project; see [Setup](../docs/SETUP.md#sync-backend-optional).

The HTTP API is intended for the native phone client and the local Python sync
agent, and the Chrome extension. CORS permits Chrome extension origins only;
regular website origins are rejected. Unpacked extension IDs may vary, so the
pairing Bearer token remains the authorization boundary. Configure `SYNC_TOKEN`
as a randomly generated pairing secret of at least 32 characters in the Convex
deployment environment. Clients send `Authorization: Bearer <pairing secret>`;
a Convex deployment/admin key is never a client credential.

- `GET /health`: unauthenticated availability check.
- `GET /sync`: document summaries and server epoch seconds. `?format=2` also returns deleted-article tombstones.
- `GET /documents?id=…`: full article with current metadata and progress.
- `POST /documents`: full article upsert; returns `{document: summary}`.
- `PUT /progress`: `{id, position, updated}`.
- `PUT /tags`: `{id, tags, metadataUpdated}`.
- `PUT /read-status`: `{id, unread, readUpdated}`; manual read status is independent of playback.
- `PUT /lifecycle`: `{id, archived, deleted, lifecycleUpdated}`; archive is reversible, an accepted delete is permanent for that ID.
- `POST /images`: PNG/JPEG/GIF/WebP bytes, up to 5 MiB; returns `{id, url}`.
- `GET /images?id=…`: authenticated raster response. Returned image URLs are
  relative to this HTTP deployment; attach the pairing header when fetching.

Article requests are bounded to 20 MiB. Full words, paragraphs and image metadata
are stored as a JSON storage blob; the database stores only small summary fields.
Images must already be registered uploads from this deployment. Raw Convex storage
URLs are never returned. Every database function is internal.

Progress (`updated`), tags/title/source (`metadataUpdated`), and content
(`contentUpdated`), and manual read status (`readUpdated`) merge independently. Timestamps are epoch seconds and must not
be more than five minutes ahead of server time. A larger timestamp wins; ties keep
the already accepted version. New shorter content clamps the saved word position.
Stale uploaded blobs are deleted. Accepted historical content blobs are retained
so concurrent readers can finish; periodic storage cleanup can be added if needed.

Local verification:

```
bunx tsc -p convex/tsconfig.json
bunx vitest run convex/sync.test.ts
```

Article uploads may include `unread` (boolean) and `readUpdated` (epoch seconds),
but both must be supplied together. Legacy clients omitting both never overwrite
read status. Responses always include defaults `unread: true, readUpdated: 0` for
legacy rows; internally their absent read clock compares as -1, so the first
explicit clock of zero is accepted. Equal read clocks keep the accepted value.

Full articles may include `marks`: up to 50,000 objects with `start` / `end`
global word offsets (end exclusive) and `kind` equal to `bold`, `italic`,
`underline`, or `link`. Link marks require an HTTP(S) `href` without credentials;
other marks cannot have an `href`. No raw HTML is stored. Marks live in the content
blob and follow `contentUpdated`, independently of progress, tags and read status.
Legacy omitted marks and old content blobs read as `[]`.

Clients supporting quote paragraphs should fetch `/documents?id=…&format=2`.
Those responses preserve `paragraph.kind: "blockquote"` and report
`formatVersion: 2`. Legacy requests receive quote blocks downgraded to ordinary
paragraphs and `formatVersion: 1`, without changing the stored content or marks.
