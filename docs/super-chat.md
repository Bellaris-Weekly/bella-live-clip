# Scrolling Super Chats

## 1. Scope

SC rendering is implemented in bella-live-clip first. BiliUploadAuto receives the
agreed design only after the user approves the browser effect. New work consumes
the collector's Parquet contract; no legacy-field adapter or historical migration
is part of the renderer.

## 2. Entry points

- `readDanmaku(file, options)` selects both `danmaku` and `sc` row groups.
- `createCommentReader(...).read(window)` freezes a snapshot per demanded window.
- `measureCapsule`, `drawCapsule`, `scSpeed`, `commentPreroll` share geometry.
- `createAvatarCache(...).prefetch(events, retained)` starts optional bounded work.
- `createDanmakuPainter` serves both preview and export. Its `overlayOpacity`
  accompanies `renderOverlay`; `superChatOverlay` is a separate top-area layer
  with opacity baked in per sprite (SC 85%, member bands opaque). Both callers
  composite the two layers once, with no outer CSS opacity or full-frame
  alpha-mask pass.

## 3. Contract

DM and SC rows require stable `event_id` and integer `order`. Equal text remains
separate receipts; overlapping archive partitions emit each receipt once. SC adds
`sc_id`, `price`, `bg_color`, `header_color`, `font_color`, and nullable `face`.
The paid event becomes `kind: 'sc', mode: 1` at normalization. Missing required
schema fields fail visibly rather than switching source formats.

The B capsule has a dark `header_color` head with white currency/amount, a light
`bg_color` body with tier-colored text, a circular static avatar with a white ring, and
the same height as ordinary text. Body text is 0.8 of the ordinary font size,
single-line and limited to 40 Unicode grapheme clusters, plus an ellipsis.
Amounts use a text font, avoiding colored emoji digits on hosts without the named
CJK fonts. Body text uses the tier `header_color` darkened by 25%, without a
stroke; the platform `font_color` belongs to its dark-card design. Geometry caps even pathological glyph widths at 48
body font sizes.

SC moves at `200 * width / 1920` pixels/second and uses 85% opacity. Ordinary
comments retain their existing speed and combined-layer 75% opacity. Ready events
are ordered: member comments, then SCs of at least ¥30 (`SC_PRIORITY_PRICE`) by
amount, then cheaper SCs (mostly ¥2) and ordinary comments in arrival order.
Members, SCs and each ordinary mode are separate queues, so one blocked queue
never holds back another, and active comments are never preempted. SCs of at least
¥30 wait at most five seconds, members ten, cheaper SCs 1.5 seconds like
ordinary comments. `droppedSuperChats` counts capacity timeouts of
both. Seek lookback includes maximum capsule width, traversal and the member
wait; 1080p/4K landscape currently needs 31 seconds, with a geometry-derived
value for other aspect ratios. Live window boundaries retain active layout
instead of replaying events.

Measured 2026-11-13 over 102 archived sessions: 5181 ¥2 SCs, 3721 ¥30, 406 ¥50,
286 ¥100 and a few dozen at other amounts.

Avatars allow the observed `i*.hdslb.com/bfs/{face,garb,baselabs}/` paths, request
192px CDN thumbnails, decoded at the member avatar size (`2.2 * fontSize`), without credentials or a referrer, as one static bitmap. Each compositor has at most three concurrent downloads and 128 entries,
a 2 MiB response cap, three-second request timeout, and 60-second failure cooldown.
Only preparation prefetches. The avatar slot is always reserved; until the image
arrives it shows a portrait placeholder, and a late image re-rasters only that
capsule without changing its dimensions or stalling media.

### Member comments

A danmaku row whose `uid` is one of `MEMBERS` (any member, so visits count too)
is a member comment. It shares SC speed and the top layer but is drawn as a
distinct, fully opaque band and always scrolls, even if sent as a fixed comment.
Promotion text filtering does not apply; text made only of whitespace or
zero-width characters is skipped.

The band is always two lines tall: a two-line emote (`1.8 * fontSize`) plus a
3px inset, filled with the member color (`MEMBERS.color`, the cheer color) from
18% lighter at the top to 8% darker at the bottom, with a white inner edge and
an 8px glow in the member color. The member's `face` from `MEMBERS` (danmaku
rows carry none) is drawn 10px larger than the band, overhanging it with a white
ring. Text is ordinary danmaku style (white, black stroke, soft shadow) at 1.3x
the ordinary font size. At 1080p an item is 104px, so the top 23% fits two.

Member comments keep emotes. Text runs are drawn in the cached sprite; emotes
are separate parts drawn per frame on the top layer, so animation never
re-rasters the band. Emotes past the width cap are dropped; a failed emote
re-measures the band with its `[name]` text. SC text never loads emotes.

Measured 2026-11-13 over 102 archived sessions of the five rooms: 52 member
comments, 2 with two-line emotes; danmaku rows carry no face, hence the fixed
faces in `MEMBERS`.

## 4. Validation and errors

| Condition | Behavior |
| --- | --- |
| Missing receipt identity/order or required columns | Visible archive error |
| Invalid/nonpositive amount or empty SC text | Skip invalid paid event |
| Missing/failed avatar | Placeholder in the fixed slot; late arrival fills it |
| Duplicate-looking text, different receipt | Preserve both |
| Same receipt in overlapping archive partitions | Emit once |
| SC cannot fit by five seconds | Count a capacity drop |
| Cancel/close | Abort pending avatar work and release images/sprites |

## 5. Cases

Good: long and short SCs move together; a slow leading SC cannot be overtaken by
ordinary text in its lane. Base: no SC uses the original ordinary rendering path.
Bad: reset a long SC at the next ten-second window or resize it when its face arrives.

## 6. Verification

`tools/tests/unit/super-chat.test.mjs` covers graphemes, speed, collisions, queue
priority, lookback, producer-format fixtures, avatar URL admission and resource
bounds. Archive tests cover stable receipts and overlap. The Chromium SC test
covers actual bitmap decoding, alpha (217/255 versus 166/255), sprite reuse,
preview/export pixel equality and streaming-window equality. Existing compositor
and export browser tests remain regression checks. These are not BiliUploadAuto
live throughput or upload-deadline acceptance.

Run `node tools/scripts/sc-review.mjs` to build an isolated SC userscript and
a standalone interactive HTML review. Disable the installed release while testing
the review userscript on the same page. The manual visual preview in
`tools/tests/e2e/super-chat-page.js` uses the same painter on synthetic events. Generated review HTML, screenshots and local timing
results live in `.local/sc-review/`; no recording is independently produced.

## 7. Wrong versus correct

Wrong: use ordinary comment duration for SC seek history, fetch faces in each
frame, interpret blank intervals as proof of coverage, or claim zero rendering
cost from sprite caching. Correct: retain the full fixed-speed lifetime, prefetch
optional images, preserve the collector's completeness contract, and measure
actual rendering costs separately from end-to-end production acceptance.
