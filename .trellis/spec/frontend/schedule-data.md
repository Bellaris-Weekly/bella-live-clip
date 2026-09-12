# Recording schedule metadata

## Scope / Trigger
The recording library enriches Bella, Diana and Eileen records from the monthly calendar. The recording API remains the source of title and actual start/end times.

## Signatures
`new ScheduleService(request).enrich(records, {signal, refresh=false})` returns `{records, failed}`. `createRecordCard(record, onSelect)` consumes enriched records.

## Contracts
Each copied record has `schedule: null | {type, participants: [{id, name, color, avatar}]}`. `failed` reports calendar failures only. Avatar lookup failure yields null and is not cached. Requests are anonymous, using `calendar-YYYY-MM.ics` and Bilibili public profile faces. Successful calendars expire after one hour; refresh bypasses them. No new credentials or environment variables.

## Validation and Error Matrix
- Folded ICS lines: unfold before splitting fields; decode escaped description delimiters.
- UTC or Asia/Shanghai event start: normalize to Unix seconds; reject invalid dates and cancelled events.
- Match: same room, unique nearest start within 30 minutes; equal-distance ambiguity yields null.
- Month boundary: load months covering start ± 30 minutes in Beijing, including prior year if needed. Incomplete candidate months yield null.
- Missing or failed calendar: keep record selectable with original metadata; never infer participants from room ownership.
- Participant annotations: resolve the name token before whitespace annotations; do not enumerate individual suffixes such as ended/not-started.
- Navigation/refresh/close: abort background enrichment; late results must not update another member or editing page.

## Good / Base / Bad Cases
Good: a dual show supplies two participant avatars, independent of the room owner. Base: unmatched recording displays original title, date and actual duration. Bad: using planned DURATION or schedule SUMMARY to overwrite recording metadata.

## Tests Required
`tests/schedule.test.mjs` covers folding, annotations, multiple shows, timezones, cross-month/year lookup, ambiguity, TTL, retry and cancellation. `tests/cards-browser.js` checks titles, visible text, portrait counts, fallback, narrow layout, member switching and navigation during enrichment.

## Wrong vs Correct
Wrong: `record.title = event.summary; duration = event.duration`.
Correct: retain `record.title` and `record.end - record.start`; attach only `record.schedule`. Card widths are capped at 244px; use auto-fill columns rather than stretching sparse rows. The Beijing date block includes day, month, weekday and time. Room-owner colors style the card without implying participation. Render external text with textContent. Participant names belong in accessibility labels/tooltips, not visible adjacent labels.
