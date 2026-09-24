# Project Thanos

Hold ⌥ Option on any web page and ask a question out loud. Everything that doesn't answer
it fades away, and the layout stays exactly where it was. Or switch to Highlight mode and
the answer lights up instead.

[Jev](https://typesafe.ai) decides what stays. The page is collapsed into a tree of items,
and Jev walks it from the top: it keeps a whole section or card, leaves it out, or digs
into its children, down to single sentences.

## Install

1. Download `project-thanos.zip` and unzip it.
2. In the unzipped folder, copy `config.example.js` to `config.js` and add your keys:
   - `TYPESAFE_API_KEY` (required): Jev decides what stays. Get one at [typesafe.ai](https://typesafe.ai).
   - `OPENAI_API_KEY` (optional): for the Whisper / 4o voice engines.
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick
   the folder.
4. Pin the extension (puzzle-piece icon → pin) and pick a voice engine in its popup.

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

Click the extension icon to switch:

- **Effect**: Thanos (everything else disappears) or Highlight (the answer glows).
- **Engine**: Tree (keeps cards whole, digs into prose) or Sentences (every sentence scored on
  its own).
- **Voice**: Chrome (built in, no key), Whisper (`whisper-1`), 4o mini
  (`gpt-4o-mini-transcribe`) or 4o (`gpt-4o-transcribe`, the most accurate). The OpenAI
  engines fall back to Chrome's transcript if a request fails.

## Build the zip

```bash
rm -rf build && mkdir -p build/project-thanos
cp extension/{manifest.json,*.html,*.css,background.js,content.js,popup.js,config.example.js} build/project-thanos/
cd build && zip -r project-thanos.zip project-thanos
```
