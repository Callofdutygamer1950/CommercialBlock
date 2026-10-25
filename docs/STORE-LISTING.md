# Firefox Add-ons (AMO) listing text

Copy each section into the matching field on addons.mozilla.org.

## Name

CommercialBlock

## Summary

Skip commercials on YouTube TV in Firefox. Jumps past DVR commercial breaks using YouTube TV's own data plus breaks marked by the community, and skips ads in on-demand episodes.

## Description

CommercialBlock skips commercials when you watch YouTube TV (tv.youtube.com) in Firefox on a computer.

**On-demand episodes** (shows not recorded to your DVR)
YouTube TV plays these ads as separate short videos while the show waits. CommercialBlock jumps through each one in under a second, then the show picks up right where it left off.

**DVR recordings**
• Automatic: YouTube TV's own data says where some commercial breaks are. Those are skipped with no setup (yellow marks on the progress bar).
• Community: for breaks YouTube TV doesn't list, anyone can mark the start and end. Press ; when the commercials start and again when the show comes back. Shared breaks are skipped for everyone (green marks), and 👍/👎 votes filter out bad ones.
• After every skip you get an Undo button.
• "Still ads?" button: YouTube TV's data often covers only part of a break; one click lets you mark the rest.
• Snap to length: commercials come in 15-second blocks, so CommercialBlock offers to round your marks to the exact length.

**Privacy**
• Looking up breaks sends only the first 4 characters of a hash of the recording ID, so the server can't tell what you are watching.
• Sharing or voting sends the recording ID, the break times, and a random ID created by the extension (not linked to you). No names, emails, or account details are collected.
• Open source (GPL-3.0): https://github.com/Callofdutygamer1950/CommercialBlock

**Limits**
• Works on tv.youtube.com in desktop Firefox only, not the YouTube TV apps on TVs or phones.
• Not affiliated with YouTube or Google. If YouTube TV changes its website, some features may need an update.

## Categories

Firefox: **Privacy & Security** and **Photos, Music & Videos**

## Tags

youtube tv, ad skipper, commercials, dvr, sponsorblock

## Support website

https://github.com/Callofdutygamer1950/CommercialBlock/issues

## License

GNU General Public License v3.0

## Privacy policy

Check "This add-on has a privacy policy" and paste the contents of PRIVACY.md.

## Source code question

"Do You Need to Submit Source Code?" → **No**. Nothing is minified, bundled, or generated; the uploaded files are the source.

## Notes for Reviewers

CommercialBlock skips commercials on tv.youtube.com. Source: https://github.com/Callofdutygamer1950/CommercialBlock (identical to the uploaded files; no build step, no minification, no third-party libraries, no remote code).

Files:
- content/page-bridge.js runs in the MAIN world because it must call YouTube TV's player object (#movie_player: getPlayerResponse(), getCurrentTime(), seekTo()). It reads the ad placement times from the player response and exchanges small messages with content.js via window.postMessage. It has no extension privileges and never receives the user's random ID.
- content/content.js (isolated world): skipping logic, the marking UI (built with DOM APIs, no innerHTML), progress-bar markers, and on-demand ad skipping (sets the ad <video>'s currentTime to its end while #movie_player has the "ad-showing" class; falls back to muted 16x playback).
- content/segments.js: pure logic, unit tested.
- background.js: the only network code. Calls three Postgres functions on the developer's Supabase project over HTTPS (get_segments, submit_segment, vote_segment). The key in config.js is Supabase's public "publishable" key; the database only exposes those three functions (schema: supabase/setup.sql in the repository).

Data collection (declared in data_collection_permissions: browsingActivity, websiteActivity):
- Lookups send only a 4-hex-character prefix of SHA-256(recording ID).
- Submitting/voting (user clicks only) sends the recording ID, break times, recording length, channel ID, and a random per-install ID (stored server-side only as a hash) used for rate limiting and one-vote-per-user.
- Nothing is stored from private windows.

Testing: YouTube TV requires a paid US subscription, so a test account can't be provided. The repository includes a simulated YouTube TV player (tests/fake-player.html) and end-to-end tests (tests/e2e.js) that exercise every feature against it.
