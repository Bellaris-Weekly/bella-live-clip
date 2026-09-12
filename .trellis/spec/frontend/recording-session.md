# Recording Session and Rendering

## 1. Scope / Trigger
Changes to recording navigation, shared manifests, export input, or control rendering must preserve the contracts below.

## 2. Signatures
- `new RecordingPlan(api, streams, lifetimeSignal).load(consumerSignal?) -> Promise<groups>`
- `estimateRecordingRate(api, groups, signal)`
- `exportSelection(api, record, groups, selection, options)`
- `saveRecording(api, groups, fileHandle, options)`
- `createControls(root, timeline) -> update({busy, ready, page, whole})`

## 3. Contracts
- One plan belongs to one successful `player.load`. Preview keeps its HLS loader; estimates and both export modes share the plan.
- `groups` retain parsed `segments`, `map`, and local `offset`; `start` is the absolute Unix start of the group, and `streamEnd` is the API-reported end of its parent stream. Selection offsets use `group.start - record.start` and exclude streams ending at or before the selection start.
- Concurrent plan consumers share one pending read. Successful data stays in memory for this recording only. Returning, changing records, or refreshing aborts the old lifetime and discards its plan. No credentials, signed URLs, or media are persisted.
- Consumer cancellation only stops that consumer's wait. The lifetime signal owns shared network requests; the export signal owns export media reads and file operations.
- `leavePage()` owns schedule and recording cancellation, estimate/selection reset, playback cleanup, and object URL revocation. Closing the panel only hides it and pauses playback; it preserves the loaded recording and exports.
- Busy state derives from the active foreground controller. Controls calculate final disabled states directly, preserve button nodes, and skip unchanged writes. Newly rendered cards receive the current busy state.
- Timeline progress and playhead scrubbing update only the pointer. Five tick nodes are reused; selection/view changes render labels and bounds, while locking only updates disabled state.
- Export reads normalized media duration only. Complete media inspection belongs to `tests/media-info.mjs`. Keep normalization and trimming separate until raw timestamp/codec behavior is independently verified.

## 4. Validation & Error Matrix
- Manifest network or parse failure: reject all current waiters, discard the failed promise, and allow the next operation to retry.
- Aborted consumer: reject immediately without canceling the shared read; remove the abort listener after settlement.
- Aborted recording: reject late results and prevent reuse of its cached plan.
- No intersecting recording: reject before requesting media segments.
- File cancellation, network failure, or disk failure: abort the writable file; never close a partial export as successful.
- Whole-recording picker: invoke during the click activation, before awaiting the plan.

## 5. Good / Base / Bad Cases
- Good: estimate and two exports reuse one manifest read; refreshing the same live recording reads a new manifest.
- Base: one recording with a single segment yields the same selected MP4 duration.
- Bad: attaching the shared manifest request to the first export's cancel signal; caching a rejected promise; allowing old estimate callbacks to update a new recording.

## 6. Tests Required
- `recording-plan.test.mjs`: shared requests, discontinuity and stream offsets, refresh, independent cancellation, late results, retry, listener cleanup.
- `recording.test.mjs`: shared-plan selection exports and full writes for plain and initialized fragments, actual output durations, reported stream bounds, abort-on-failure.
- `controls.test.mjs` and `timeline-render.test.mjs`: final enabled states, unchanged DOM writes, stable nodes, dynamic cards, pointer-only updates.
- Browser page `?slow-media`: run scene cleanup/refresh checks while estimate requests are pending. Card checks cover normal, narrow, missing schedule, and delayed schedule views. Real media export checks verify audio, video, duration, and decoded files.

## 7. Wrong vs Correct
Wrong: each export parses a fresh playlist and stores `busy` separately from its controller.
Correct: `const groups = await recordingPlan.load(exportSignal)`; both exports consume those groups, and `Boolean(controller)` supplies busy state.
