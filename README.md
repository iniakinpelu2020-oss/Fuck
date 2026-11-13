# Apex IDE

Single-page, browser-based web IDE and autonomous coding agent workspace built with **HTML**, **Tailwind CSS (CDN)**, and **vanilla JavaScript**.

## Cloudflare Managed AI (server-side proxy)

Apex IDE can work out of the box on Cloudflare Pages using server-side keys (never exposed to frontend). Add these Environment Variables in **Cloudflare Pages → Settings → Environment variables**:
1. `APEX_API_KEYS` — comma-separated upstream API keys for rotation (e.g. `key1,key2,key3`)
2. `APEX_API_URL` — upstream OpenAI-compatible chat completions URL (e.g. `https://openrouter.ai/api/v1/chat/completions`)
3. `APEX_DEFAULT_MODEL` — default model id (e.g. `openai/gpt-4o-mini`)

`functions/api/chat.js` serves `/api/chat` with automatic key rotation on `429/401/403`; `_routes.json` limits Functions to `/api/*` so static assets stay free. If a user provides custom keys in the UI (BYOK), the frontend can send a custom `Authorization` header/endpoint override instead of using managed keys.

## Features

### Left Panel — Explorer, Local Access & Binary Support
- **Local File System Access** via `window.showDirectoryPicker()` (Chromium-based browsers): open local folders, edit files, and save back to disk where supported.
- **File tree workspace**: create, switch, and remove files from the workspace view (in-memory or local-backed).
- **GitHub Repository Cloner**: imports public repository file structures/content into a workspace using the GitHub REST API (token optional for higher rate limits/private metadata access where permitted).
- **Binary & package inspection**: drop/parse `.apk`, `.exe`, `.dmg` (and zip-like packages) to show signatures, metadata, archive/manifests, heuristic strings, and hex previews.

### Center Workspace — Editor & Terminal
- **Code editor** with line numbers, syntax highlighting (highlight.js), tab/Save shortcuts, and language selection.
- **Built-in terminal UI** (xterm.js) with WebSocket bridge support for backend shell execution (`npm`, `node`, `python`, etc.).
  - Configure/connect to a terminal bridge (e.g. `ws://localhost:3001/terminal`).
  - Browser-only environments cannot spawn local shells directly; a backend bridge is required for real command execution.

### Right Panel — Agent, MCP, RAG & Vault
- **Autonomous coding agent chat** with workspace-aware prompts.
- **Multi-key API rotator**: store multiple API keys and automatically rotate/fallback on rate/auth-limit responses.
- **MCP Manager**: configure WebSocket JSON-RPC MCP servers, connect, and discover tools for agent context/execution workflows.
- **Local Context Indexer (RAG)**: client-side chunking and similarity search backed by IndexedDB to retrieve relevant snippets.
- **Integration & credential vault**: store API keys, OAuth tokens, webhook URLs, and configs locally for agent/automation use.

### Automation Bridge
- Exposes `window.ApexWorkflowBridge` (alias: `window.ApexAutomationBridge`, with `AetherWorkflowBridge` compatibility) in `js/integrations.js` for lightweight external automation hooks.
- Uses the configured external webhook/automation URL (Settings) or a stored webhook credential in the Vault.
- Example: `await ApexWorkflowBridge.trigger('manual', { ref: 'main' })`.

### Unified Execution & Agent Logic
- Bundles active workspace context, optional RAG snippets, and MCP tool metadata into prompts.
- Routes LLM requests through configurable provider endpoints with key rotation.
- Parses agent JSON edit blocks (````json:edits````) to auto-apply file edits and optionally forward terminal commands.

## Running

Open `index.html` in a modern browser (preferably Chromium for Directory Picker support):

```bash
# from /workspace/app
python3 -m http.server 8080
# then open http://localhost:8080
```

No build step required.

## Notes & Limits
- **Local folder save/open**: best supported in Chromium browsers via File System Access API.
- **Terminal execution**: requires a compatible WebSocket shell bridge backend.
- **GitHub cloning**: uses GitHub API; subject to rate limits and import caps for large repos.
- **Binary inspection**: provides static/heuristic analysis in-browser; full decompilation/disassembly may require native tools.
- **Secrets**: stored in browser local storage/IndexedDB for this demo workspace; handle with care.

## Project Structure
- `index.html` — application layout and UI
- `styles.css` — editor/chat/layout styling
- `js/utils.js` — shared helpers
- `js/state.js` — app state and persistence
- `js/fileTree.js` — explorer/local FS/GitHub import
- `js/editor.js` — editor, highlighting, edits
- `js/terminal.js` — xterm.js terminal bridge client
- `js/binary.js` — binary/package inspection
- `js/rag.js` — IndexedDB chunking/search
- `js/mcp.js` — MCP JSON-RPC client
- `js/integrations.js` — credential vault and external automation webhook bridge
- `js/agent.js` — chat agent, key rotation, context bundling
- `js/app.js` — initialization and UI wiring
