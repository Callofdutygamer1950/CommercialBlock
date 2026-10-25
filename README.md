# CommercialBlock

A Firefox extension that skips commercials in YouTube TV DVR recordings (tv.youtube.com in a desktop browser).

**On-demand episodes** (not recorded to DVR) play ads as separate short videos inside the player while the show waits (`#movie_player` has the `ad-showing` class). CommercialBlock jumps each ad to its end so the player moves straight on; if YouTube TV ever blocks that, it mutes the ads and plays them at 16×.

For **DVR recordings**, it uses two sources of commercial breaks:

1. **YouTube TV's own break list.** When a recording loads, YouTube TV tells the player where it plans to insert ads. CommercialBlock reads that list and skips those breaks automatically. This works with zero users.
2. **Community-marked breaks.** For breaks YouTube TV doesn't list, anyone can mark the start and end (press `;` twice, or use the button at the top right of the player). Breaks are shared through a Supabase database and voted up or down, like SponsorBlock.

## Project layout

| Path | What it is |
|---|---|
| `extension/` | The Firefox extension (Manifest V3, Firefox 140+) |
| `extension/config.js` | Supabase URL + public key (empty = community sharing off, marks saved locally) |
| `extension/content/page-bridge.js` | Runs in the page; reads YouTube TV's player (break list, time, seek) |
| `extension/content/content.js` | Skipping, marking UI, progress-bar markers, skip notice |
| `extension/content/segments.js` | Pure break logic (merging, voting threshold, validation) |
| `extension/background.js` | Talks to Supabase |
| `supabase/setup.sql` | Database tables, security rules, and the 3 functions the extension calls |
| `tests/` | Unit tests (`node --test tests/segments.test.js`) and a browser simulation (`tests/e2e.js`) |

## Privacy

- To look up community breaks, the extension sends only the first 4 characters of a SHA-256 hash of the recording ID, so the server can't tell exactly what you're watching.
- Submitting or voting sends the recording ID, the break times, and a random ID generated in your browser (stored on the server only as a hash). No account, name, or email is collected.

## Server rules

- Breaks must be 4 seconds to 15 minutes long.
- Up to 30 submissions and 200 votes per browser per hour.
- A near-duplicate submission counts as an upvote of the existing break.
- Breaks with a score of −2 or lower are hidden. Set `hidden = true` in the `segments` table to remove one by hand, or add a `user_hash` to `banned_users` to block a spammer.
