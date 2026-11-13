# Document fonts

Embedded as `data:` URIs in every note and conversation export (plan 03 item 1; fonts chosen by the human 2026-11-13), so a downloaded file looks like the app in any browser. All three are under the SIL Open Font License 1.1 (the `OFL-*.txt` files here).

| File | Font | Source | Used for |
| --- | --- | --- | --- |
| `source-sans-3-latin.woff2` | Source Sans 3, variable 200–900, Latin | The Google Fonts file `next/font` downloads for the app (`app/layout.tsx`), unmodified | Text, every page |
| `cmu-serif-bold.woff2` | CMU Serif Bold | `public/fonts/cmunbx.ttf` re-encoded to WOFF2 with fontTools (`TTFont(...).flavor = "woff2"`), no other change, so the name is kept under the OFL's reserved-name rule | Titles, every page |
| `jetbrains-mono-latin.woff2` | JetBrains Mono, variable 100–800, Latin | The Google Fonts file `next/font` downloads for the app, unmodified | Code, only pages with code |

Characters outside these files fall back to the reader's system fonts, as in the app.
