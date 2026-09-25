# Project Thanos

Hold ⌥ Option on any web page and ask a question out loud. Everything that doesn't answer
it crumbles away like the Thanos snap, and the layout stays exactly where it was. Or switch
to Highlights Mode and the answer lights up instead.

[Jev](https://typesafe.ai) decides what stays. The page is collapsed into a tree of items,
and Jev walks it from the top: it keeps a whole section or card, leaves it out, or digs
into its children, down to single sentences.

## Install

1. Clone this repo, or download it (**Code → Download ZIP**) and unzip it.
2. In that folder, copy `config.example.js` to `config.js` and add your keys (`config.js` is
   gitignored, so your keys never get committed):
   - `TYPESAFE_API_KEY` (required): Jev decides what stays. Get one at [typesafe.ai](https://typesafe.ai).
   - `OPENAI_API_KEY` (optional): for the Whisper / 4o voice engines.
   - `VOICE` and `ENGINE`: which voice engine and which page engine to use (see below).
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick
   the folder.
4. Pin the extension (puzzle-piece icon → pin). Clicking Thanos opens a small panel at the
   top right of the page; it stays while you browse until you close it.

Your keys stay in that folder and are sent only to TypeSafe and OpenAI. After editing
`config.js`, click ↻ on the extension to reload it.

## Use

| | |
|---|---|
| Hold ⌥, speak, let go | Ask the page |
| Hold ⌥ again | Ask something else; the page moves straight to the new answer |
| Double-tap ⌥ or Esc | Bring the whole page back |
| ⌘⇧K | Type a question instead of speaking |

The first time you hold ⌥ on a site, Chrome asks for microphone access.

The panel's slider picks the effect: left is **Highlights Mode** (the answer glows), right
is **Thanos Mode** (everything else crumbles to dust, like Google's old Thanos snap). The
toolbar icon grins when Thanos is on. The dust is cut from a screenshot of the visible
page, which is why the extension asks for access to all sites.

In `config.js`:

- `VOICE`: `"chrome"` (built in, no key), `"whisper-1"`, `"gpt-4o-mini-transcribe"`, or
  `"gpt-4o-transcribe"` (the most accurate). The OpenAI engines fall back to Chrome's
  transcript if a request fails.
- `ENGINE`: `"tree"` (keeps cards whole, digs into prose) or `"sentences"` (every sentence
  scored on its own).
