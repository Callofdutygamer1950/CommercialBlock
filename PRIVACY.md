# CommercialBlock Privacy Policy

_Last updated: October 25, 2026_

CommercialBlock is a Firefox extension that skips commercials on YouTube TV (tv.youtube.com). This policy explains what it does with data.

## Data that stays on your computer

These are stored only in your browser (Firefox extension storage) and are never sent anywhere:

- Your settings.
- Counters shown in the popup (commercials skipped, time saved, breaks shared).
- Commercial breaks you marked but haven't shared.
- A list of which community breaks you voted on (so you don't vote twice).

Nothing is saved from private browsing windows.

## Data sent to the CommercialBlock server

Community commercial breaks are stored in a database run by the developer on Supabase (supabase.com). The extension contacts it in three situations:

1. **When you open a recording**, to look up community-marked breaks. Only the **first 4 characters of a SHA-256 hash** of the recording's ID are sent. Many recordings share each prefix, so the server can't tell which recording you are watching. The matching is finished on your computer.
2. **When you share a commercial break** (only when you click "Share with community" or "Share all with community"): the recording's ID, the start and end times of the break, the recording's length, the TV channel's ID, and a random ID created by the extension on your computer.
3. **When you vote on a break** (👍 or 👎): the break's ID, your vote, and the same random ID.

The random ID is a long random string generated when you first use the extension. It is not linked to your name, email, Google or YouTube TV account, or any other identity, and the server only stores a one-way hash of it. It exists to stop the same browser from voting many times and to limit spam.

Like any website, the server can see your IP address when the extension connects. CommercialBlock doesn't store it.

## What is never collected

- Your name, email address, or any account details (Google, YouTube TV, or Mozilla).
- Your viewing history (except the hash prefix described above).
- Anything about websites other than tv.youtube.com.

## How the data is used

Shared breaks and votes are used only to skip commercials for all CommercialBlock users. They are not sold, shared with third parties, or used for advertising or analytics.

## Deleting your data

- To delete the data on your computer, remove the extension from Firefox.
- Shared breaks are not linked to you. To ask for a break to be removed, open an issue at https://github.com/Callofdutygamer1950/CommercialBlock/issues.

## Contact

Questions: https://github.com/Callofdutygamer1950/CommercialBlock/issues
