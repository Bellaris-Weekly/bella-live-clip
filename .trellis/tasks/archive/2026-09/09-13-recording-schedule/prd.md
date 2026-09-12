# Recording card schedule metadata
User approved implementation on 2026-09-13 with corrections: original title only; no visible participant names.
## Goal
Replace repeated covers with useful compact recording information.
## Requirements
All five members: no covers, original title, Beijing date/time and actual recording duration. Bella, Diana and Eileen: enrich using calendar-YYYY-MM.ics with type and participant avatars. No visible names alongside avatars. Names may be accessible labels/tooltips. Unknown schedule must not invent participants or type. Calendar failures must not prevent selecting recordings.
## Acceptance
Match by room and start time, handle same-day multiple shows, Chinese ICS folded lines, cross-month records, missing schedules and failed avatars. Preserve original playback/download behavior. npm run verify and wide/narrow browser QA pass.
## Scope
Card UI, dedicated schedule loader/parser/matcher, public avatar fetch, metadata connect grant, tests, README, generated userscript. No changes to media or export logic. No deployment requested.
