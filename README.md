# ChatGPT Branch Tree Navigator (Chrome Extension)

This extension adds a branch-tree panel on `chatgpt.com` that:

- Fetches full conversation graph data (`mapping`) from ChatGPT's conversation API.
- Renders message nodes as a tree of small cards.
- Shows a branch preview with the selected message and its assistant reply.
- Provides an **Open Branch** action that replays branch choices in the existing ChatGPT UI.

## Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:
   - `/Users/haziq/Desktop/Projects/GPT_BranchView`

## How to use

1. Open any conversation URL in ChatGPT:
   - `https://chatgpt.com/c/<conversation_id>`
2. Click **Branch Tree**.
3. Select any node card in the tree.
4. Review the preview.
5. Click **Open Branch** to switch the main chat view to that branch path.

## Architecture

- `manifest.json`: MV3 extension manifest.
- `background.js`: service worker "backend" for cached API fetches.
- `page-bridge.js`: page-context fetch bridge (uses first-party ChatGPT session context).
- `content.js`: in-page controller + frontend tree/preview UI + branch navigation logic.
- `styles.css`: panel and node-card styling.

## Notes and limitations

- ChatGPT DOM controls for branch switching are not guaranteed stable. The extension uses robust heuristics (message text matching + nearby variant controls), but UI changes can break navigation behavior.
- The extension captures ChatGPT's own in-page conversation network responses first (`page-bridge.js` on `document_start`), waits briefly for capture availability, then falls back to iframe navigation fetch.
- The tree currently renders only `user` and `assistant` message nodes for clarity.
