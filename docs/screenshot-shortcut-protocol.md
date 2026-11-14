# Shared Live Screenshot Shortcut

## 1. Scope / Trigger

Changes to screenshot keyboard handling or settings shared with bella-live-clip.
Keep `src/screenshot-shortcut.js` and clip's `src/ui/screenshot-shortcut.js`
identical except for their CommonJS/ES module wrappers. Do not share media data.

## 2. Signatures

`createScreenshotShortcut({document, clientId, read, write})` returns
`get()`, `set(shortcut): boolean`, `conflicts(shortcut, except)`,
`registerAction(name, shortcut)` and `subscribe(listener)`.

`bindScreenshotShortcut({input, shortcut, format, onConflict})` binds a settings field.

## 3. Contracts

- Default: `KeyP` with all modifiers false. Launchers and preview mark shortcuts also accept a single primary key.
- Dedicated GM and same-origin cache key: `bellaScreenshotShortcutV1`. Value:
  `{shortcut: {code, ctrlKey, altKey, shiftKey, metaKey}, updatedAt, source}`.
  Merge all initial candidates before persisting; order by timestamp, then source.
  Forwarding retains the revision. Only explicit edits advance it.
- Same-page sandbox bridge: JSON attribute `data-bella-screenshot-shortcut-v1`
  plus `bella-screenshot-shortcut-change-v1`. No object-valued custom event detail.
- Keyboard ownership: `data-bella-screenshot-keys-v1`; independent of existing
  `data-bella-live-screenshot-installed` button ownership. Dispatch `.click()` only
  to an enhanced control containing `[data-bella-screenshot-icon]`.
- Frame message channel: `bella-screenshot-shortcut-v1`; `hello`, `config` (record),
  `capture`. Verify parent/direct-child Window identity and origin. A referrer-free
  child may send only the empty hello to `*`; config/capture use an exact origin.
- Select one visible player, preferring native fullscreen, focused frame, then
  last interacted player / largest visible video. Hidden controls remain usable.
  Direct capture stays synchronous in keydown; an iframe request routes only to
  the selected child. Do not negotiate ownership on each press or retry via the other plugin.
- No storage listener / cross-tab immediate updates. Refresh can recover the cached
  configuration. Dedicated storage must not overwrite the existing preference object.
- Product strings approved: `截图快捷键`, `按下快捷键`, `快捷键已被占用`.
  Every additional or changed product string requires user confirmation.

## 4. Validation & Error Matrix

- Modifier alone / Escape / unidentified key -> ignore (Escape cancels recording).
- Input, textarea, select, contenteditable, shadow input, composing, repeat -> no screenshot.
- Existing action collision -> reject edit, preserve binding, use approved conflict text.
- No enhanced control/ready frame -> leave event untouched; never invoke original feedback.
- Invalid/unavailable storage -> keep usable in-memory defaults; no popup.

## 5. Good / Base / Bad Cases

Good: new GIF shortcut calls a legacy clip-owned camera, including in fullscreen.
Base: one installed plugin captures once on P. Bad: both plugins independently bind capture or an old setting overwrites a newer cached edit during hydration.

## 6. Tests Required

- `tests/screenshot-shortcut.test.js`: independent VM sandboxes, both startup orders,
  live configuration propagation, conflicts, hidden controls, player replacement,
  storage failure and no cross-tab live updates. Equivalent tests live in clip.
- `tests/screenshot-shortcut-browser.mjs <clip-repo> <chromium>` after both builds:
  actual bundles / legacy screenshot module; original-resolution PNG downloads;
  web/player/browser fullscreen, same/cross-origin frame focus and routing,
  actual settings fields, single-key launchers, and a seeded 1.4.x preference upgrade.
- Run each repository's `npm run verify`. Keep GIF encoding, rewind and resources unchanged.

## 7. Wrong vs Correct

Wrong: a new plugin fails to add its shortcut because the old plugin owns the camera.
Correct: claim keyboard ownership separately and invoke the already-enhanced camera.

Wrong: use a hidden camera's dimensions to choose the player.
Correct: use its associated video's dimensions, then invoke that camera even when hidden.
