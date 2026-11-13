# Scrolling Super Chats

## 1. Scope

SC rendering is implemented in bella-live-clip first. BiliUploadAuto receives the
agreed design only after the user approves the browser effect. New work consumes
the collector's Parquet contract; no legacy-field adapter or historical migration
is part of the renderer.

## 2. Entry points

- `readDanmaku(file, options)` selects both `danmaku` and `sc` row groups.
- `createCommentReader(...).read(window)` freezes a snapshot per demanded window.
- `measureSuperChat`, `drawSuperChat`, `scSpeed`, `commentPreroll` share geometry.
- `createAvatarCache(...).prefetch(events, retained)` starts optional bounded work.
- `createDanmakuPainter` serves both preview and export. Its `overlayOpacity`
  accompanies `renderOverlay`; `superChatOverlay` is a separate top-area layer
  at `superChatOpacity`. Both callers composite the two layers once, with no
  outer CSS opacity or full-frame alpha-mask pass.

## 3. Contract

DM and SC rows require stable `event_id` and integer `order`. Equal text remains
separate receipts; overlapping archive partitions emit each receipt once. SC adds
`sc_id`, `price`, `bg_color`, `header_color`, `font_color`, and nullable `face`.
The paid event becomes `kind: 'sc', mode: 1` at normalization. Missing required
schema fields fail visibly rather than switching source formats.

The B capsule has a dark header with white currency/amount, light body with dark
text, a circular static avatar slot, and the same height as ordinary text.
Backgrounds use message colors. Body text is single-line and limited to 40 Unicode
grapheme clusters, plus an ellipsis. Amounts use a text font, avoiding colored
emoji digits on hosts without the named CJK fonts. The platform `font_color` is
preserved but belongs to its dark-card design, so B uses dark text on its light
body. Geometry caps even pathological glyph widths at 48 body font sizes.

SC moves at `200 * width / 1920` pixels/second and uses 85% opacity. Ordinary
comments retain their existing speed and combined-layer 65% opacity. SC has a
five-second queue deadline and priority among ready events without preempting
active comments or blocking the ordinary FIFO. `droppedSuperChats` diagnoses
capacity timeouts. Seek lookback includes maximum SC width, traversal and waiting;
1080p/4K landscape currently needs 26 seconds, with a geometry-derived value for
other aspect ratios. Live window boundaries retain active layout instead of
replaying events.

Avatars allow the observed `i*.hdslb.com/bfs/{face,garb,baselabs}/` paths, request
96px CDN thumbnails without credentials or a referrer, and decode one static
bitmap. Each compositor has at most three concurrent downloads and 128 entries,
a 2 MiB response cap, three-second request timeout, and 60-second failure cooldown.
Only preparation prefetches; placement freezes the available avatar. A late or
failed image never changes an active capsule's dimensions or stalls media.

## 4. Validation and errors

| Condition | Behavior |
| --- | --- |
| Missing receipt identity/order or required columns | Visible archive error |
| Invalid/nonpositive amount or empty SC text | Skip invalid paid event |
| Missing/failed/late avatar | Empty fixed slot; amount and text still render |
| Duplicate-looking text, different receipt | Preserve both |
| Same receipt in overlapping archive partitions | Emit once |
| SC cannot fit by five seconds | Count a capacity drop |
| Cancel/close | Abort pending avatar work and release images/sprites |

## 5. Cases

Good: long and short SCs move together; a slow leading SC cannot be overtaken by
ordinary text in its lane. Base: no SC uses the original ordinary rendering path.
Bad: reset a long SC at the next ten-second window or change its face after entry.

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
