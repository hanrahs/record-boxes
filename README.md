# Record Boxes

A small phone app for recording which storage box each vinyl record is packed in.

- Loads your collection from Discogs. You need your username and a personal access token, which are stored only on your device.
- Search, then tap to put a record in the box you're currently packing. Boxes can be nested (outer 101 → inner 101A).
- Exports a CSV spreadsheet and printable box lists, and backs up to any cloud drive through the share menu.

All data stays on the device. There's no server and no account.

## Install

Open the site in Chrome on Android → ⋮ → **Add to Home screen**.

## Updating

After changing any file, bump `VERSION` in `sw.js` so installed copies pick up the change.
