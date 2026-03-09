# Conversation Branch Tree Navigator

## Features

- Supports `chatgpt.com` and `claude.ai` conversations.
- Builds a visual tree of conversation branches created from message edits.
- Search through your chat.
- `Open Branch` action that lets you switch the live chat UI to the selected branch and message.
- Branch preview panel with full selected turn content.
- Pan and zoom support for navigating large trees.
- Adjustable layout controls:
  - Global spacing
  - Vertical spacing
  - Horizontal spacing
  - Node font size

## Installation

1. Open `chrome://extensions` (or `brave://extensions`).
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this project directory:
   - `/Users/haziq/Desktop/Projects/GPT_BranchView`
5. Reload the extension after code changes.

## Usage

1. Open a supported conversation page:
   - `https://chatgpt.com/c/<conversation_id>`
   - `https://claude.ai/chat/<conversation_id>`
2. Click the extension icon in the browser toolbar.
3. Select a node in the tree to view its branch preview.
4. Use search or spacing/zoom controls to navigate large conversations.
5. Click **Open Branch** to switch the main chat view to that branch when possible.

## How It Works

The extension is a Manifest V3 browser extension with three main runtime layers:

1. Content layer (`content.js` + `styles.css`)
   - Injects the tree UI into supported pages.
   - Parses conversation data into visible turn nodes.
   - Handles tree rendering, search, preview, panning, zooming, and branch navigation.
   - Receives toolbar-click messages from the service worker to open/close the panel.

2. Page bridge layer (`page-bridge.js`)
   - Runs in page context to access first-party network responses and authenticated fetch context when needed.
   - Provides a safer fallback path when direct extension-context requests are unreliable.

3. Background/service worker layer (`background.js`)
   - Handles extension action clicks (`chrome.action.onClicked`) and forwards toggle messages to the active tab.
   - Provides cached API fetch support for ChatGPT conversation payloads.

At render time, the conversation graph is normalized into turn nodes, laid out as a vertical tree, then drawn into an interactive canvas. Branch switching is performed by driving the existing site UI with provider-specific DOM heuristics.

## Project Structure

- `manifest.json`: extension metadata, permissions, content scripts, and action config.
- `background.js`: service worker, toolbar click handling, and cached fetch messaging.
- `content.js`: UI logic, data shaping, rendering, search, and branch navigation.
- `styles.css`: panel, controls, and tree styling.
- `page-bridge.js`: page-context bridge for capture/fetch flows.
- `icons/`: extension icon assets.

## Notes

- If tree doesn't load immediately, hit `Refresh` in the top right and try again.
- Branch opening depends on live site DOM controls and can break if ChatGPT or Claude UI markup changes.
- The extension intentionally filters to meaningful user/assistant turn content for readability.
- Large conversations can still be computationally heavy, but panning, zooming, and search are designed to keep navigation practical.

