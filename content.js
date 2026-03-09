(() => {
  if (window.__CGBT_EXTENSION_LOADED__) {
    return;
  }
  window.__CGBT_EXTENSION_LOADED__ = true;

  const PANEL_STATE_STORAGE_KEY = "cgbtPanelOpen";
  const TREE_SPACING_STORAGE_KEY = "cgbtTreeSpacing";
  const TREE_VERTICAL_SPACING_STORAGE_KEY = "cgbtTreeVerticalSpacing";
  const TREE_HORIZONTAL_SPACING_STORAGE_KEY = "cgbtTreeHorizontalSpacing";
  const NODE_FONT_SIZE_STORAGE_KEY = "cgbtNodeFontSize";
  const ROUTE_POLL_MS = 800;
  const NAV_CLICK_DELAY_MS = 280;
  const DOM_SEARCH_TIMEOUT_MS = 4_000;
  const DOM_SEARCH_SCROLL_DELAY_MS = 110;
  const DOM_SEARCH_SCROLL_STEP_RATIO = 0.72;
  const PAGE_BRIDGE_TIMEOUT_MS = 12_000;
  const PAGE_BRIDGE_CAPTURE_TIMEOUT_MS = 4_000;
  const IFRAME_FETCH_TIMEOUT_MS = 12_000;
  const CLAUDE_CONVERSATION_QUERY = "tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong";
  const UI_VERSION = "2026-02-26-workflow-tree-v2";
  const TREE_NODE_WIDTH = 280;
  const TREE_NODE_HEIGHT = 124;
  const TREE_LEVEL_GAP = 146;
  const TREE_SIBLING_GAP = 36;
  const TREE_ROOT_GAP = 64;
  const TREE_CANVAS_PADDING = 72;
  const TREE_VISUAL_BASE_SCALE = 0.8;
  const TREE_ZOOM_MIN = 0.55;
  const TREE_ZOOM_MAX = 1.9;
  const TREE_ZOOM_STEP = 0.1;
  const TREE_SPACING_MIN = 20;
  const TREE_SPACING_MAX = 150;
  const TREE_HORIZONTAL_SPACING_MAX = 250;
  const NODE_FONT_SIZE_MIN = 70;
  const NODE_FONT_SIZE_MAX = 180;
  const PREVIEW_SPLIT_MIN = 30;
  const PREVIEW_SPLIT_MAX = 82;
  const PAGE_BRIDGE_SOURCE_CONTENT = "CGBT_CONTENT";
  const PAGE_BRIDGE_SOURCE_PAGE = "CGBT_PAGE";

  let pageBridgeReadyPromise = null;
  let pageBridgeListenerAttached = false;
  let pageBridgeRequestCounter = 0;
  const pageBridgePending = new Map();
  const pageBridgeCapturePending = new Map();

  const state = {
    conversationId: null,
    provider: null,
    claudeOrganizationId: null,
    data: null,
    mapping: null,
    rootId: null,
    visibleNodes: [],
    visibleNodeIds: new Set(),
    selectedNodeId: null,
    searchQuery: "",
    searchMatches: [],
    searchMatchSet: new Set(),
    searchIndex: -1,
    loadingPromise: null,
    navigating: false,
    lastPathname: "",
    panelOpen: false,
    hasConversation: false,
    pendingCapturedRetry: false,
    previewVisible: false,
    panX: 26,
    panY: 26,
    zoom: 1,
    spacingPercent: 100,
    verticalSpacingPercent: 100,
    horizontalSpacingPercent: 100,
    fontSizePercent: 100,
    settingsOpen: false,
    panDragging: false,
    panPointerId: null,
    panStartClientX: 0,
    panStartClientY: 0,
    panStartX: 0,
    panStartY: 0,
    previewSplitPercent: 66,
    previewResizing: false,
    previewResizePointerId: null,
    ui: null
  };

  attachPageBridgeMessageListener();
  waitForDocumentReady().then(init);

  function waitForDocumentReady() {
    if (document.readyState === "interactive" || document.readyState === "complete") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
    });
  }

  function init() {
    mountUi();
    attachUiEvents();
    restorePanelState();

    state.lastPathname = location.pathname;
    handleRouteChange(true);

    window.addEventListener("popstate", () => handleRouteChange(false));

    setInterval(() => {
      if (location.pathname !== state.lastPathname) {
        handleRouteChange(false);
      }
      ensurePreviewSelectionConsistency();
    }, ROUTE_POLL_MS);
  }

  function attachPageBridgeMessageListener() {
    if (pageBridgeListenerAttached) {
      return;
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window) {
        return;
      }

      const message = event.data;
      if (!message || typeof message !== "object" || message.source !== PAGE_BRIDGE_SOURCE_PAGE) {
        return;
      }

      if (message.type === "CGBT_PAGE_CAPTURED_CONVERSATION") {
        const capturedConversationId =
          typeof message.conversationId === "string" ? message.conversationId : "";
        if (capturedConversationId && state.conversationId === capturedConversationId && !state.mapping) {
          if (state.loadingPromise) {
            state.pendingCapturedRetry = true;
          } else {
            void refreshConversation({ force: false });
          }
        }
        return;
      }

      if (message.type === "CGBT_PAGE_GET_CAPTURED_RESULT") {
        const requestId = typeof message.requestId === "string" ? message.requestId : "";
        if (!requestId || !pageBridgeCapturePending.has(requestId)) {
          return;
        }

        const pending = pageBridgeCapturePending.get(requestId);
        pageBridgeCapturePending.delete(requestId);
        window.clearTimeout(pending.timeoutId);

        const found = Boolean(message.found);
        if (!found) {
          pending.resolve(null);
          return;
        }

        if (message.ok && message.data && typeof message.data === "object" && message.data.mapping) {
          pending.resolve(message.data);
          return;
        }

        const errorMessage =
          typeof message.error === "string" && message.error
            ? message.error
            : "Captured conversation payload was invalid.";
        pending.reject(new Error(errorMessage));
        return;
      }

      if (message.type === "CGBT_PAGE_FETCH_RESULT") {
        const requestId = typeof message.requestId === "string" ? message.requestId : "";
        if (!requestId || !pageBridgePending.has(requestId)) {
          return;
        }

        const pending = pageBridgePending.get(requestId);
        pageBridgePending.delete(requestId);
        window.clearTimeout(pending.timeoutId);

        if (message.ok && message.data && typeof message.data === "object" && message.data.mapping) {
          pending.resolve(message.data);
          return;
        }

        const status =
          typeof message.status === "number" && Number.isFinite(message.status)
            ? ` (${message.status})`
            : "";
        const errorMessage =
          typeof message.error === "string" && message.error
            ? message.error
            : `Page-context fetch failed${status}.`;

        pending.reject(new Error(errorMessage));
        return;
      }
    });

    pageBridgeListenerAttached = true;
  }

  function ensurePageBridgeInjected() {
    if (pageBridgeReadyPromise) {
      return pageBridgeReadyPromise;
    }

    pageBridgeReadyPromise = new Promise((resolve) => {
      const bridgeScript = document.createElement("script");
      bridgeScript.src = chrome.runtime.getURL("page-bridge.js");
      bridgeScript.async = false;
      bridgeScript.dataset.cgbtPageBridge = "1";

      bridgeScript.onload = () => {
        bridgeScript.remove();
        resolve();
      };

      bridgeScript.onerror = () => {
        bridgeScript.remove();
        resolve();
      };

      (document.head || document.documentElement).appendChild(bridgeScript);
    });

    return pageBridgeReadyPromise;
  }

  async function fetchConversationViaPageBridge(conversationId) {
    await ensurePageBridgeInjected();

    return new Promise((resolve, reject) => {
      const requestId = `cgbt-${Date.now()}-${++pageBridgeRequestCounter}`;
      const timeoutId = window.setTimeout(() => {
        pageBridgePending.delete(requestId);
        reject(new Error("Page-context fetch timed out."));
      }, PAGE_BRIDGE_TIMEOUT_MS);

      pageBridgePending.set(requestId, { resolve, reject, timeoutId });

      window.postMessage(
        {
          source: PAGE_BRIDGE_SOURCE_CONTENT,
          type: "CGBT_PAGE_FETCH_CONVERSATION",
          requestId,
          conversationId
        },
        "*"
      );
    });
  }

  async function getCapturedConversationViaPageBridge(conversationId) {
    await ensurePageBridgeInjected();

    return new Promise((resolve, reject) => {
      const requestId = `cgbt-capture-${Date.now()}-${++pageBridgeRequestCounter}`;
      const timeoutId = window.setTimeout(() => {
        pageBridgeCapturePending.delete(requestId);
        reject(new Error("Captured conversation lookup timed out."));
      }, PAGE_BRIDGE_CAPTURE_TIMEOUT_MS);

      pageBridgeCapturePending.set(requestId, { resolve, reject, timeoutId });

      window.postMessage(
        {
          source: PAGE_BRIDGE_SOURCE_CONTENT,
          type: "CGBT_PAGE_GET_CAPTURED_CONVERSATION",
          requestId,
          conversationId
        },
        "*"
      );
    });
  }

  function mountUi() {
    const existingRoot = document.getElementById("cgbt-root");
    if (existingRoot) {
      existingRoot.remove();
    }

    const root = document.createElement("div");
    root.id = "cgbt-root";
    root.setAttribute("data-ui-version", UI_VERSION);
    root.innerHTML = `
      <button id="cgbt-toggle" type="button" hidden>Conversation Branches</button>
      <aside id="cgbt-panel">
        <div id="cgbt-header">
          <div id="cgbt-header-copy">
            <div id="cgbt-title">Conversation Branches</div>
            <div id="cgbt-subtitle"></div>
          </div>
          <div id="cgbt-header-actions">
            <div id="cgbt-search-controls">
              <input
                id="cgbt-search-input"
                type="search"
                spellcheck="false"
                autocomplete="off"
                placeholder="Search chat"
                aria-label="Search chat"
              />
              <button id="cgbt-search-prev" type="button" aria-label="Previous match">Prev</button>
              <button id="cgbt-search-next" type="button" aria-label="Next match">Next</button>
              <span id="cgbt-search-count">0 / 0</span>
            </div>
            <button id="cgbt-refresh" type="button">Refresh</button>
            <button id="cgbt-close" type="button">Close</button>
          </div>
        </div>
        <div id="cgbt-status" class="cgbt-muted" hidden></div>
        <div id="cgbt-main" class="cgbt-preview-closed">
          <section id="cgbt-tree-section">
            <div id="cgbt-tree-head">
              <span id="cgbt-tree-title">Conversation Branches</span>
              <div id="cgbt-tree-head-right">
                <div id="cgbt-inline-controls">
                  <div id="cgbt-spacing-controls" class="cgbt-control-group">
                    <span id="cgbt-spacing-label">Spacing</span>
                    <input
                      id="cgbt-spacing-range"
                      type="range"
                      min="${TREE_SPACING_MIN}"
                      max="${TREE_SPACING_MAX}"
                      step="5"
                      value="100"
                      aria-label="Tree spacing"
                    />
                    <span id="cgbt-spacing-value">100%</span>
                  </div>
                  <div id="cgbt-font-controls" class="cgbt-control-group">
                    <span id="cgbt-font-label">Font</span>
                    <input
                      id="cgbt-font-range"
                      type="range"
                      min="${NODE_FONT_SIZE_MIN}"
                      max="${NODE_FONT_SIZE_MAX}"
                      step="5"
                      value="100"
                      aria-label="Node font size"
                    />
                    <span id="cgbt-font-value">100%</span>
                  </div>
                </div>
                <button id="cgbt-settings-toggle" type="button" aria-label="Open settings" aria-expanded="false">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M19.43 12.98a7.85 7.85 0 0 0 .06-.98 7.85 7.85 0 0 0-.06-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.36 7.36 0 0 0-1.7-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.49.42l-.38 2.65a7.36 7.36 0 0 0-1.7.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65a7.85 7.85 0 0 0-.06.98 7.85 7.85 0 0 0 .06.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.52.4 1.09.73 1.7.98l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .49-.42l.38-2.65c.61-.25 1.18-.58 1.7-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"></path>
                  </svg>
                </button>
                <div id="cgbt-settings-menu" hidden>
                  <div class="cgbt-settings-row">
                    <div id="cgbt-zoom-controls" class="cgbt-control-group">
                      <button id="cgbt-zoom-out" type="button" aria-label="Zoom out">-</button>
                      <button id="cgbt-zoom-reset" type="button" aria-label="Reset zoom">100%</button>
                      <button id="cgbt-zoom-in" type="button" aria-label="Zoom in">+</button>
                    </div>
                  </div>
                  <div class="cgbt-settings-row">
                    <div id="cgbt-vspacing-controls" class="cgbt-control-group">
                      <span id="cgbt-vspacing-label">Vertical Spacing</span>
                      <input
                        id="cgbt-vspacing-range"
                        type="range"
                        min="${TREE_SPACING_MIN}"
                        max="${TREE_SPACING_MAX}"
                        step="5"
                        value="100"
                        aria-label="Vertical spacing"
                      />
                      <span id="cgbt-vspacing-value">100%</span>
                    </div>
                  </div>
                  <div class="cgbt-settings-row">
                    <div id="cgbt-hspacing-controls" class="cgbt-control-group">
                      <span id="cgbt-hspacing-label">Horizontal Spacing</span>
                      <input
                        id="cgbt-hspacing-range"
                        type="range"
                        min="${TREE_SPACING_MIN}"
                        max="${TREE_HORIZONTAL_SPACING_MAX}"
                        step="5"
                        value="100"
                        aria-label="Horizontal spacing"
                      />
                      <span id="cgbt-hspacing-value">100%</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div id="cgbt-tree-viewport">
              <div id="cgbt-tree-canvas"></div>
            </div>
          </section>
          <div id="cgbt-preview-resizer" hidden role="separator" aria-orientation="horizontal"></div>
          <section id="cgbt-preview-section" hidden>
            <div id="cgbt-preview-head">
              <div id="cgbt-preview-title">Branch Preview</div>
              <button id="cgbt-open-branch" type="button" disabled>Open Branch</button>
            </div>
            <div id="cgbt-preview-empty">Select a node to preview the message and its assistant reply.</div>
            <div id="cgbt-preview-content" hidden>
              <div class="cgbt-preview-block">
                <div class="cgbt-preview-label">Message</div>
                <pre id="cgbt-preview-message"></pre>
              </div>
              <div class="cgbt-preview-block">
                <div class="cgbt-preview-label">Assistant Response</div>
                <pre id="cgbt-preview-response"></pre>
              </div>
            </div>
          </section>
        </div>
      </aside>
    `;

    document.documentElement.appendChild(root);

    state.ui = {
      root,
      toggle: root.querySelector("#cgbt-toggle"),
      panel: root.querySelector("#cgbt-panel"),
      close: root.querySelector("#cgbt-close"),
      refresh: root.querySelector("#cgbt-refresh"),
      subtitle: root.querySelector("#cgbt-subtitle"),
      status: root.querySelector("#cgbt-status"),
      main: root.querySelector("#cgbt-main"),
      treeSection: root.querySelector("#cgbt-tree-section"),
      treeViewport: root.querySelector("#cgbt-tree-viewport"),
      treeCanvas: root.querySelector("#cgbt-tree-canvas"),
      previewResizer: root.querySelector("#cgbt-preview-resizer"),
      previewSection: root.querySelector("#cgbt-preview-section"),
      openBranch: root.querySelector("#cgbt-open-branch"),
      previewTitle: root.querySelector("#cgbt-preview-title"),
      previewEmpty: root.querySelector("#cgbt-preview-empty"),
      previewContent: root.querySelector("#cgbt-preview-content"),
      previewMessage: root.querySelector("#cgbt-preview-message"),
      previewResponse: root.querySelector("#cgbt-preview-response"),
      inlineControls: root.querySelector("#cgbt-inline-controls"),
      settingsToggle: root.querySelector("#cgbt-settings-toggle"),
      settingsMenu: root.querySelector("#cgbt-settings-menu"),
      zoomOut: root.querySelector("#cgbt-zoom-out"),
      zoomReset: root.querySelector("#cgbt-zoom-reset"),
      zoomIn: root.querySelector("#cgbt-zoom-in"),
      zoomControls: root.querySelector("#cgbt-zoom-controls"),
      spacingRange: root.querySelector("#cgbt-spacing-range"),
      spacingValue: root.querySelector("#cgbt-spacing-value"),
      spacingControls: root.querySelector("#cgbt-spacing-controls"),
      vSpacingRange: root.querySelector("#cgbt-vspacing-range"),
      vSpacingValue: root.querySelector("#cgbt-vspacing-value"),
      vSpacingControls: root.querySelector("#cgbt-vspacing-controls"),
      hSpacingRange: root.querySelector("#cgbt-hspacing-range"),
      hSpacingValue: root.querySelector("#cgbt-hspacing-value"),
      hSpacingControls: root.querySelector("#cgbt-hspacing-controls"),
      fontRange: root.querySelector("#cgbt-font-range"),
      fontValue: root.querySelector("#cgbt-font-value"),
      fontControls: root.querySelector("#cgbt-font-controls"),
      searchInput: root.querySelector("#cgbt-search-input"),
      searchPrev: root.querySelector("#cgbt-search-prev"),
      searchNext: root.querySelector("#cgbt-search-next"),
      searchCount: root.querySelector("#cgbt-search-count")
    };

    updateZoomControls();
    updateSpacingControls();
    updateVerticalSpacingControls();
    updateHorizontalSpacingControls();
    updateFontSizeControls();
    updateSettingsMenuVisibility();
    updateSearchUi();
    setConversationUiAvailable(false);
    applyTreePanTransform();
    applyNodeFontScale();
    applyPreviewSplit();
  }

  function attachUiEvents() {
    state.ui.toggle.addEventListener("click", () => {
      setPanelOpen(!state.panelOpen, true);
    });

    state.ui.close.addEventListener("click", () => {
      setPanelOpen(false, true);
    });

    state.ui.refresh.addEventListener("click", () => {
      void refreshConversation({ force: true });
    });

    state.ui.treeCanvas.addEventListener("click", (event) => {
      const card = event.target.closest(".cgbt-node-card");
      if (!card) {
        clearSelectedNode();
        return;
      }
      const nodeId = card.getAttribute("data-node-id");
      if (!nodeId) {
        return;
      }
      if (state.selectedNodeId === nodeId && state.previewVisible) {
        clearSelectedNode();
        return;
      }
      selectNode(nodeId, { focusTreeNode: false });
    });
    state.ui.treeCanvas.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      const card = event.target.closest(".cgbt-node-card");
      if (!card) {
        return;
      }
      const nodeId = card.getAttribute("data-node-id");
      if (!nodeId) {
        return;
      }
      event.preventDefault();
      selectNode(nodeId, { focusTreeNode: false });
    });

    state.ui.treeViewport.addEventListener("click", onTreeViewportClick);
    state.ui.treeViewport.addEventListener("pointerdown", onTreePointerDown);
    state.ui.treeViewport.addEventListener("pointermove", onTreePointerMove);
    state.ui.treeViewport.addEventListener("pointerup", onTreePointerUp);
    state.ui.treeViewport.addEventListener("pointercancel", onTreePointerUp);
    state.ui.treeViewport.addEventListener("lostpointercapture", onTreePointerUp);
    state.ui.treeViewport.addEventListener("wheel", onTreeWheel, { passive: false });

    state.ui.zoomOut.addEventListener("click", () => {
      setTreeZoom(state.zoom - TREE_ZOOM_STEP, { preserveViewportCenter: true });
    });
    state.ui.zoomIn.addEventListener("click", () => {
      setTreeZoom(state.zoom + TREE_ZOOM_STEP, { preserveViewportCenter: true });
    });
    state.ui.zoomReset.addEventListener("click", () => {
      setTreeZoom(1, { preserveViewportCenter: true });
    });
    state.ui.spacingRange.addEventListener("input", () => {
      const value = Number.parseInt(state.ui.spacingRange.value, 10);
      setTreeSpacing(value, { persist: false });
    });
    state.ui.spacingRange.addEventListener("change", () => {
      const value = Number.parseInt(state.ui.spacingRange.value, 10);
      setTreeSpacing(value, { persist: true });
    });
    state.ui.vSpacingRange.addEventListener("input", () => {
      const value = Number.parseInt(state.ui.vSpacingRange.value, 10);
      setVerticalTreeSpacing(value, { persist: false });
    });
    state.ui.vSpacingRange.addEventListener("change", () => {
      const value = Number.parseInt(state.ui.vSpacingRange.value, 10);
      setVerticalTreeSpacing(value, { persist: true });
    });
    state.ui.hSpacingRange.addEventListener("input", () => {
      const value = Number.parseInt(state.ui.hSpacingRange.value, 10);
      setHorizontalTreeSpacing(value, { persist: false });
    });
    state.ui.hSpacingRange.addEventListener("change", () => {
      const value = Number.parseInt(state.ui.hSpacingRange.value, 10);
      setHorizontalTreeSpacing(value, { persist: true });
    });
    state.ui.fontRange.addEventListener("input", () => {
      const value = Number.parseInt(state.ui.fontRange.value, 10);
      setNodeFontSize(value, { persist: false });
    });
    state.ui.fontRange.addEventListener("change", () => {
      const value = Number.parseInt(state.ui.fontRange.value, 10);
      setNodeFontSize(value, { persist: true });
    });
    state.ui.settingsToggle.addEventListener("click", () => {
      setSettingsOpen(!state.settingsOpen);
    });

    state.ui.previewResizer.addEventListener("pointerdown", onPreviewResizerPointerDown);
    state.ui.previewResizer.addEventListener("pointermove", onPreviewResizerPointerMove);
    state.ui.previewResizer.addEventListener("pointerup", onPreviewResizerPointerUp);
    state.ui.previewResizer.addEventListener("pointercancel", onPreviewResizerPointerUp);
    state.ui.previewResizer.addEventListener("lostpointercapture", onPreviewResizerPointerUp);

    state.ui.searchInput.addEventListener("input", () => {
      setSearchQuery(state.ui.searchInput.value);
    });
    state.ui.searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      if (event.shiftKey) {
        focusSearchMatchByOffset(-1);
      } else {
        focusSearchMatchByOffset(1);
      }
    });
    state.ui.searchPrev.addEventListener("click", () => {
      focusSearchMatchByOffset(-1);
    });
    state.ui.searchNext.addEventListener("click", () => {
      focusSearchMatchByOffset(1);
    });

    state.ui.openBranch.addEventListener("click", () => {
      void navigateToSelectedBranch();
    });

    document.addEventListener("pointerdown", onGlobalPointerDown, true);
  }

  function onGlobalPointerDown(event) {
    if (!state.ui || !state.panelOpen || !state.hasConversation) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }

    const insideRoot = state.ui.root.contains(target);
    if (!insideRoot) {
      clearSelectedNode();
      setSettingsOpen(false);
      return;
    }

    if (state.settingsOpen) {
      const insideSettings = state.ui.settingsMenu.contains(target) || state.ui.settingsToggle.contains(target);
      if (!insideSettings) {
        setSettingsOpen(false);
      }
    }
  }

  function onTreeViewportClick(event) {
    if (event.target.closest(".cgbt-node-card")) {
      return;
    }
    clearSelectedNode();
  }

  function onPreviewResizerPointerDown(event) {
    if (!state.previewVisible || event.button !== 0) {
      return;
    }

    state.previewResizing = true;
    state.previewResizePointerId = event.pointerId;
    state.ui.main.classList.add("cgbt-resizing");
    state.ui.previewResizer.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPreviewResizerPointerMove(event) {
    if (!state.previewResizing || event.pointerId !== state.previewResizePointerId) {
      return;
    }

    const rect = state.ui.main.getBoundingClientRect();
    if (!rect || rect.height <= 0) {
      return;
    }
    const relativeY = clamp(event.clientY - rect.top, 0, rect.height);
    const percent = (relativeY / rect.height) * 100;
    setPreviewSplitPercent(percent);
  }

  function onPreviewResizerPointerUp(event) {
    if (!state.previewResizing) {
      return;
    }
    if (
      event.pointerId !== undefined &&
      state.previewResizePointerId !== null &&
      event.pointerId !== state.previewResizePointerId
    ) {
      return;
    }

    if (
      state.previewResizePointerId !== null &&
      event.type !== "lostpointercapture" &&
      state.ui.previewResizer.hasPointerCapture(state.previewResizePointerId)
    ) {
      state.ui.previewResizer.releasePointerCapture(state.previewResizePointerId);
    }

    state.previewResizing = false;
    state.previewResizePointerId = null;
    state.ui.main.classList.remove("cgbt-resizing");
  }

  function setPreviewSplitPercent(value) {
    state.previewSplitPercent = clamp(
      Number.isFinite(value) ? value : state.previewSplitPercent,
      PREVIEW_SPLIT_MIN,
      PREVIEW_SPLIT_MAX
    );
    applyPreviewSplit();
  }

  function applyPreviewSplit() {
    if (!state.ui || !state.ui.main || !state.ui.previewResizer || !state.ui.treeSection) {
      return;
    }

    if (!state.previewVisible) {
      state.ui.main.style.removeProperty("--cgbt-tree-split");
      state.ui.previewResizer.hidden = true;
      state.ui.previewResizer.style.display = "none";
      return;
    }

    state.ui.main.style.setProperty("--cgbt-tree-split", `${state.previewSplitPercent}%`);
    state.ui.previewResizer.hidden = false;
    state.ui.previewResizer.style.display = "block";
  }

  function onTreeWheel(event) {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    const direction = event.deltaY > 0 ? -1 : 1;
    const step = direction > 0 ? TREE_ZOOM_STEP : -TREE_ZOOM_STEP;
    setTreeZoom(state.zoom + step, {
      preserveViewportCenter: false,
      anchorClientX: event.clientX,
      anchorClientY: event.clientY
    });
  }

  function onTreePointerDown(event) {
    if (event.button !== 0) {
      return;
    }
    if (event.target.closest(".cgbt-node-card")) {
      return;
    }

    clearSelectedNode();

    state.panDragging = true;
    state.panPointerId = event.pointerId;
    state.panStartClientX = event.clientX;
    state.panStartClientY = event.clientY;
    state.panStartX = state.panX;
    state.panStartY = state.panY;

    state.ui.treeViewport.classList.add("cgbt-panning");
    state.ui.treeViewport.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onTreePointerMove(event) {
    if (!state.panDragging || event.pointerId !== state.panPointerId) {
      return;
    }

    const deltaX = event.clientX - state.panStartClientX;
    const deltaY = event.clientY - state.panStartClientY;
    state.panX = state.panStartX + deltaX;
    state.panY = state.panStartY + deltaY;
    applyTreePanTransform();
  }

  function onTreePointerUp(event) {
    if (!state.panDragging) {
      return;
    }

    if (event.pointerId !== undefined && state.panPointerId !== null && event.pointerId !== state.panPointerId) {
      return;
    }

    if (
      state.panPointerId !== null &&
      event.type !== "lostpointercapture" &&
      state.ui.treeViewport.hasPointerCapture(state.panPointerId)
    ) {
      state.ui.treeViewport.releasePointerCapture(state.panPointerId);
    }

    state.panDragging = false;
    state.panPointerId = null;
    state.ui.treeViewport.classList.remove("cgbt-panning");
  }

  function applyTreePanTransform() {
    if (!state.ui || !state.ui.treeCanvas) {
      return;
    }
    const scale = Number(getEffectiveTreeScale(state.zoom).toFixed(3));
    state.ui.treeCanvas.style.transform = `translate(${Math.round(state.panX)}px, ${Math.round(state.panY)}px) scale(${scale})`;
  }

  function resetTreePan() {
    state.panX = 26;
    state.panY = 26;
    applyTreePanTransform();
  }

  function setTreeZoom(nextZoom, options = {}) {
    const clamped = clamp(nextZoom, TREE_ZOOM_MIN, TREE_ZOOM_MAX);
    if (Math.abs(clamped - state.zoom) < 0.001) {
      updateZoomControls();
      return;
    }

    const viewport = state.ui && state.ui.treeViewport ? state.ui.treeViewport : null;
    if (viewport) {
      const preserveViewportCenter = options.preserveViewportCenter !== false;
      const viewportRect = viewport.getBoundingClientRect();
      const anchorX = preserveViewportCenter
        ? viewportRect.width / 2
        : clamp((options.anchorClientX || 0) - viewportRect.left, 0, viewportRect.width);
      const anchorY = preserveViewportCenter
        ? viewportRect.height / 2
        : clamp((options.anchorClientY || 0) - viewportRect.top, 0, viewportRect.height);

      const prevScale = getEffectiveTreeScale(state.zoom);
      const nextScale = getEffectiveTreeScale(clamped);
      const worldX = (anchorX - state.panX) / prevScale;
      const worldY = (anchorY - state.panY) / prevScale;

      state.zoom = clamped;
      state.panX = anchorX - worldX * nextScale;
      state.panY = anchorY - worldY * nextScale;
    } else {
      state.zoom = clamped;
    }

    updateZoomControls();
    applyTreePanTransform();
  }

  function updateZoomControls() {
    if (!state.ui || !state.ui.zoomReset || !state.ui.zoomIn || !state.ui.zoomOut) {
      return;
    }

    const zoomPercent = Math.round(state.zoom * 100);
    state.ui.zoomReset.textContent = `${zoomPercent}%`;
    state.ui.zoomOut.disabled = state.zoom <= TREE_ZOOM_MIN + 0.001;
    state.ui.zoomIn.disabled = state.zoom >= TREE_ZOOM_MAX - 0.001;
  }

  function setTreeSpacing(value, options = {}) {
    const nextValue = clamp(Number.isFinite(value) ? value : state.spacingPercent, TREE_SPACING_MIN, TREE_SPACING_MAX);
    const rounded = Math.round(nextValue);
    const changed = rounded !== state.spacingPercent;
    state.spacingPercent = rounded;
    updateSpacingControls();

    if (changed) {
      renderTree();
    }

    if (options.persist === false) {
      return;
    }

    try {
      chrome.storage.local.set({ [TREE_SPACING_STORAGE_KEY]: state.spacingPercent });
    } catch (_error) {
      // no-op
    }
  }

  function setVerticalTreeSpacing(value, options = {}) {
    const nextValue = clamp(
      Number.isFinite(value) ? value : state.verticalSpacingPercent,
      TREE_SPACING_MIN,
      TREE_SPACING_MAX
    );
    const rounded = Math.round(nextValue);
    const changed = rounded !== state.verticalSpacingPercent;
    state.verticalSpacingPercent = rounded;
    updateVerticalSpacingControls();

    if (changed) {
      renderTree();
    }

    if (options.persist === false) {
      return;
    }

    try {
      chrome.storage.local.set({ [TREE_VERTICAL_SPACING_STORAGE_KEY]: state.verticalSpacingPercent });
    } catch (_error) {
      // no-op
    }
  }

  function setHorizontalTreeSpacing(value, options = {}) {
    const nextValue = clamp(
      Number.isFinite(value) ? value : state.horizontalSpacingPercent,
      TREE_SPACING_MIN,
      TREE_HORIZONTAL_SPACING_MAX
    );
    const rounded = Math.round(nextValue);
    const changed = rounded !== state.horizontalSpacingPercent;
    state.horizontalSpacingPercent = rounded;
    updateHorizontalSpacingControls();

    if (changed) {
      renderTree();
    }

    if (options.persist === false) {
      return;
    }

    try {
      chrome.storage.local.set({ [TREE_HORIZONTAL_SPACING_STORAGE_KEY]: state.horizontalSpacingPercent });
    } catch (_error) {
      // no-op
    }
  }

  function setNodeFontSize(value, options = {}) {
    const nextValue = clamp(
      Number.isFinite(value) ? value : state.fontSizePercent,
      NODE_FONT_SIZE_MIN,
      NODE_FONT_SIZE_MAX
    );
    state.fontSizePercent = Math.round(nextValue);
    updateFontSizeControls();
    applyNodeFontScale();

    if (options.persist === false) {
      return;
    }

    try {
      chrome.storage.local.set({ [NODE_FONT_SIZE_STORAGE_KEY]: state.fontSizePercent });
    } catch (_error) {
      // no-op
    }
  }

  function updateSpacingControls() {
    if (!state.ui || !state.ui.spacingRange || !state.ui.spacingValue) {
      return;
    }

    const clamped = clamp(state.spacingPercent, TREE_SPACING_MIN, TREE_SPACING_MAX);
    state.ui.spacingRange.value = String(Math.round(clamped));
    state.ui.spacingValue.textContent = `${Math.round(clamped)}%`;
  }

  function updateVerticalSpacingControls() {
    if (!state.ui || !state.ui.vSpacingRange || !state.ui.vSpacingValue) {
      return;
    }

    const clamped = clamp(state.verticalSpacingPercent, TREE_SPACING_MIN, TREE_SPACING_MAX);
    state.ui.vSpacingRange.value = String(Math.round(clamped));
    state.ui.vSpacingValue.textContent = `${Math.round(clamped)}%`;
  }

  function updateHorizontalSpacingControls() {
    if (!state.ui || !state.ui.hSpacingRange || !state.ui.hSpacingValue) {
      return;
    }

    const clamped = clamp(state.horizontalSpacingPercent, TREE_SPACING_MIN, TREE_HORIZONTAL_SPACING_MAX);
    state.ui.hSpacingRange.value = String(Math.round(clamped));
    state.ui.hSpacingValue.textContent = `${Math.round(clamped)}%`;
  }

  function updateFontSizeControls() {
    if (!state.ui || !state.ui.fontRange || !state.ui.fontValue) {
      return;
    }

    const clamped = clamp(state.fontSizePercent, NODE_FONT_SIZE_MIN, NODE_FONT_SIZE_MAX);
    state.ui.fontRange.value = String(Math.round(clamped));
    state.ui.fontValue.textContent = `${Math.round(clamped)}%`;
  }

  function applyNodeFontScale() {
    if (!state.ui || !state.ui.treeCanvas) {
      return;
    }
    const scale = clamp(state.fontSizePercent / 100, NODE_FONT_SIZE_MIN / 100, NODE_FONT_SIZE_MAX / 100);
    state.ui.treeCanvas.style.setProperty("--cgbt-node-font-scale", String(Number(scale.toFixed(3))));
  }

  function getTreeSpacingScale() {
    return clamp(state.spacingPercent / 100, TREE_SPACING_MIN / 100, TREE_SPACING_MAX / 100);
  }

  function getVerticalSpacingScale() {
    return clamp(state.verticalSpacingPercent / 100, TREE_SPACING_MIN / 100, TREE_SPACING_MAX / 100);
  }

  function getHorizontalSpacingScale() {
    return clamp(
      state.horizontalSpacingPercent / 100,
      TREE_SPACING_MIN / 100,
      TREE_HORIZONTAL_SPACING_MAX / 100
    );
  }

  function getTreeCanvasPadding() {
    return TREE_CANVAS_PADDING * getTreeSpacingScale();
  }

  function setSettingsOpen(open) {
    state.settingsOpen = Boolean(open);
    updateSettingsMenuVisibility();
  }

  function updateSettingsMenuVisibility() {
    if (!state.ui || !state.ui.settingsMenu || !state.ui.settingsToggle) {
      return;
    }

    const canShow = state.hasConversation && state.panelOpen;
    const visible = canShow && state.settingsOpen;

    state.ui.settingsMenu.hidden = !visible;
    state.ui.settingsMenu.style.display = visible ? "flex" : "none";
    state.ui.settingsMenu.classList.toggle("cgbt-open", visible);
    state.ui.settingsToggle.setAttribute("aria-expanded", String(visible));
    state.ui.settingsToggle.classList.toggle("cgbt-active", visible);
  }

  function getEffectiveTreeScale(rawZoom) {
    const normalizedZoom = Number.isFinite(rawZoom) ? rawZoom : 1;
    return normalizedZoom * TREE_VISUAL_BASE_SCALE;
  }

  function restorePanelState() {
    try {
      chrome.storage.local.get(
        [
          PANEL_STATE_STORAGE_KEY,
          TREE_SPACING_STORAGE_KEY,
          TREE_VERTICAL_SPACING_STORAGE_KEY,
          TREE_HORIZONTAL_SPACING_STORAGE_KEY,
          NODE_FONT_SIZE_STORAGE_KEY
        ],
        (result) => {
        if (chrome.runtime.lastError) {
          setPanelOpen(false, false);
          return;
        }

        const storedSpacing = Number.parseInt(String(result[TREE_SPACING_STORAGE_KEY] || ""), 10);
        if (Number.isFinite(storedSpacing)) {
          state.spacingPercent = clamp(storedSpacing, TREE_SPACING_MIN, TREE_SPACING_MAX);
        }
        updateSpacingControls();
        const storedVerticalSpacing = Number.parseInt(String(result[TREE_VERTICAL_SPACING_STORAGE_KEY] || ""), 10);
        if (Number.isFinite(storedVerticalSpacing)) {
          state.verticalSpacingPercent = clamp(storedVerticalSpacing, TREE_SPACING_MIN, TREE_SPACING_MAX);
        }
        updateVerticalSpacingControls();
        const storedHorizontalSpacing = Number.parseInt(String(result[TREE_HORIZONTAL_SPACING_STORAGE_KEY] || ""), 10);
        if (Number.isFinite(storedHorizontalSpacing)) {
          state.horizontalSpacingPercent = clamp(
            storedHorizontalSpacing,
            TREE_SPACING_MIN,
            TREE_HORIZONTAL_SPACING_MAX
          );
        }
        updateHorizontalSpacingControls();
        const storedFont = Number.parseInt(String(result[NODE_FONT_SIZE_STORAGE_KEY] || ""), 10);
        if (Number.isFinite(storedFont)) {
          state.fontSizePercent = clamp(storedFont, NODE_FONT_SIZE_MIN, NODE_FONT_SIZE_MAX);
        }
        updateFontSizeControls();
        applyNodeFontScale();
        updateSettingsMenuVisibility();

        const stored = result[PANEL_STATE_STORAGE_KEY];
        setPanelOpen(typeof stored === "boolean" ? stored : false, false);
      }
      );
    } catch (_error) {
      setPanelOpen(false, false);
    }
  }

  function setPanelOpen(open, persist) {
    state.panelOpen = open;
    state.ui.panel.classList.toggle("cgbt-open", open && state.hasConversation);
    state.ui.toggle.textContent = open ? "Hide Branches" : "Conversation Branches";
    if (!open) {
      state.settingsOpen = false;
    }
    updateSettingsMenuVisibility();

    if (!persist) {
      return;
    }

    try {
      chrome.storage.local.set({ [PANEL_STATE_STORAGE_KEY]: open });
    } catch (_error) {
      // no-op
    }
  }

  function handleRouteChange(initialLoad) {
    state.lastPathname = location.pathname;

    const routeContext = getConversationContextFromUrl();
    const provider = routeContext.provider;
    const conversationId = routeContext.conversationId;
    setConversationUiAvailable(Boolean(conversationId && provider));
    if (!initialLoad && conversationId === state.conversationId && provider === state.provider) {
      return;
    }

    state.provider = provider;
    state.conversationId = conversationId;
    state.claudeOrganizationId = provider === "claude" ? state.claudeOrganizationId : null;
    state.selectedNodeId = null;
    state.pendingCapturedRetry = false;
    resetTreePan();

    if (!conversationId) {
      state.ui.subtitle.textContent = "";
      clearConversationState();
      setStatus("", false);
      return;
    }

    state.ui.subtitle.textContent = "";
    void refreshConversation({ force: true });
  }

  function setConversationUiAvailable(available) {
    const hasConversation = Boolean(available);
    state.hasConversation = hasConversation;
    if (!state.ui) {
      return;
    }

    state.ui.toggle.hidden = !hasConversation;
    state.ui.panel.classList.toggle("cgbt-open", hasConversation && state.panelOpen);
    updateSettingsMenuVisibility();
  }

  function getConversationContextFromUrl() {
    const host = location.hostname.toLowerCase();

    if (host === "chatgpt.com" || host.endsWith(".chatgpt.com")) {
      const match = location.pathname.match(/\/c\/([^/?#]+)/);
      return {
        provider: "chatgpt",
        conversationId: match ? match[1] : null
      };
    }

    if (host === "claude.ai" || host.endsWith(".claude.ai")) {
      const match = location.pathname.match(/\/chat\/([^/?#]+)/);
      return {
        provider: "claude",
        conversationId: match ? match[1] : null
      };
    }

    return { provider: null, conversationId: null };
  }

  function getProviderLabel(provider) {
    if (provider === "chatgpt") {
      return "ChatGPT";
    }
    if (provider === "claude") {
      return "Claude";
    }
    return "Unknown";
  }

  async function refreshConversation(options = {}) {
    if (!state.conversationId || !state.provider) {
      return;
    }

    if (state.loadingPromise) {
      return state.loadingPromise;
    }

    state.loadingPromise = (async () => {
      setStatus("", false);

      try {
        const { data } = await fetchConversationData(
          state.provider,
          state.conversationId,
          Boolean(options.force)
        );
        const mapping = data && typeof data.mapping === "object" ? data.mapping : null;
        if (!mapping) {
          throw new Error("Conversation payload is missing mapping.");
        }

        const rootId = pickRootNodeId(mapping, data.current_node);
        if (!rootId) {
          throw new Error("Unable to find root node in mapping.");
        }

        state.data = data;
        state.mapping = mapping;
        state.rootId = rootId;
        state.visibleNodes = buildVisibleNodeList(mapping, rootId);
        state.visibleNodeIds = new Set(state.visibleNodes.map((node) => node.nodeId));
        recomputeSearchMatches({ autoSelect: false });

        renderTree();
        state.selectedNodeId = null;
        highlightSelectedNode();
        clearPreview();

        setStatus("", false);
      } catch (error) {
        clearConversationState();
        const providerLabel = getProviderLabel(state.provider);
        const conversationLabel = state.conversationId ? ` ${providerLabel} ${state.conversationId}` : "";
        setStatus(`Failed to load conversation${conversationLabel}: ${error.message}`, true);
      } finally {
        state.loadingPromise = null;

        if (state.pendingCapturedRetry && !state.mapping && state.conversationId) {
          state.pendingCapturedRetry = false;
          window.setTimeout(() => {
            void refreshConversation({ force: false });
          }, 0);
        }
      }
    })();

    return state.loadingPromise;
  }

  async function fetchConversationData(provider, conversationId, force) {
    if (provider === "claude") {
      return fetchClaudeConversationData(conversationId, force);
    }
    if (provider !== "chatgpt") {
      throw new Error("Unsupported provider for this page.");
    }
    return fetchChatGptConversationData(conversationId, force);
  }

  async function fetchChatGptConversationData(conversationId, force) {
    const errors = [];

    try {
      const capturedData = await getCapturedConversationViaPageBridge(conversationId);
      if (capturedData) {
        return { data: capturedData, source: "captured-network" };
      }
    } catch (error) {
      errors.push(`captured-network: ${error.message}`);
    }

    try {
      const waitedCapture = await waitForCapturedConversationViaPageBridge(conversationId, 4_000);
      if (waitedCapture) {
        return { data: waitedCapture, source: "captured-network-waited" };
      }
      errors.push("captured-network-waited: no captured payload observed in time window");
    } catch (error) {
      errors.push(`captured-network-waited: ${error.message}`);
    }

    try {
      const iframeData = await fetchConversationViaIframeNavigation(conversationId);
      return { data: iframeData, source: "iframe-navigation" };
    } catch (error) {
      errors.push(`iframe-navigation: ${error.message}`);
    }

    throw new Error(errors.join(" | "));
  }

  async function fetchClaudeConversationData(conversationId, _force) {
    const organizationIds = await fetchClaudeOrganizationIdsInPage();
    if (!organizationIds.length) {
      throw new Error("No Claude organizations were available for this account.");
    }

    const orderedOrgIds = organizationIds.slice();
    if (state.claudeOrganizationId && orderedOrgIds.includes(state.claudeOrganizationId)) {
      orderedOrgIds.splice(orderedOrgIds.indexOf(state.claudeOrganizationId), 1);
      orderedOrgIds.unshift(state.claudeOrganizationId);
    }

    const errors = [];
    for (const organizationId of orderedOrgIds) {
      try {
        const payload = await fetchClaudeConversationByOrganization(conversationId, organizationId);
        const normalized = normalizeClaudeConversationPayload(payload, conversationId, organizationId);
        state.claudeOrganizationId = organizationId;
        return {
          data: normalized,
          source: `claude-api/${shortId(organizationId)}`
        };
      } catch (error) {
        errors.push(`${shortId(organizationId)}: ${error.message}`);
      }
    }

    throw new Error(errors.join(" | "));
  }

  async function fetchClaudeOrganizationIdsInPage() {
    const response = await fetch("https://claude.ai/api/organizations", {
      method: "GET",
      credentials: "include"
    });
    if (!response.ok) {
      throw new Error(`Claude organizations request failed (${response.status}).`);
    }

    const data = await response.json();
    const candidates = [];

    if (Array.isArray(data)) {
      candidates.push(...data);
    } else if (data && typeof data === "object") {
      if (Array.isArray(data.organizations)) {
        candidates.push(...data.organizations);
      }
      if (Array.isArray(data.data)) {
        candidates.push(...data.data);
      }
      if (data.organization && typeof data.organization === "object") {
        candidates.push(data.organization);
      }
    }

    const organizationIds = [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      const uuid = typeof candidate.uuid === "string" ? candidate.uuid : "";
      if (uuid && !organizationIds.includes(uuid)) {
        organizationIds.push(uuid);
      }
    }

    return organizationIds;
  }

  async function fetchClaudeConversationByOrganization(conversationId, organizationId) {
    const url =
      `https://claude.ai/api/organizations/${encodeURIComponent(organizationId)}/chat_conversations/` +
      `${encodeURIComponent(conversationId)}?${CLAUDE_CONVERSATION_QUERY}`;

    const response = await fetch(url, {
      method: "GET",
      credentials: "include"
    });

    if (!response.ok) {
      throw new Error(`Claude conversation request failed (${response.status}).`);
    }

    const data = await response.json();
    if (!data || typeof data !== "object") {
      throw new Error("Claude conversation payload was not valid JSON.");
    }

    const chatMessages = extractClaudeChatMessages(data);
    if (!chatMessages.length) {
      throw new Error("Claude payload did not contain chat messages.");
    }

    return data;
  }

  function extractClaudeChatMessages(payload) {
    if (!payload || typeof payload !== "object") {
      return [];
    }

    if (Array.isArray(payload.chat_messages)) {
      return payload.chat_messages;
    }
    if (Array.isArray(payload.messages)) {
      return payload.messages;
    }
    if (payload.chat_conversation && Array.isArray(payload.chat_conversation.chat_messages)) {
      return payload.chat_conversation.chat_messages;
    }
    if (payload.chat_conversation && Array.isArray(payload.chat_conversation.messages)) {
      return payload.chat_conversation.messages;
    }
    if (payload.conversation && Array.isArray(payload.conversation.chat_messages)) {
      return payload.conversation.chat_messages;
    }
    if (payload.conversation && Array.isArray(payload.conversation.messages)) {
      return payload.conversation.messages;
    }

    return [];
  }

  function normalizeClaudeConversationPayload(payload, conversationId, organizationId) {
    const chatMessages = extractClaudeChatMessages(payload);
    const mapping = {};

    for (const rawMessage of chatMessages) {
      if (!rawMessage || typeof rawMessage !== "object") {
        continue;
      }

      const nodeId =
        typeof rawMessage.uuid === "string" && rawMessage.uuid
          ? rawMessage.uuid
          : typeof rawMessage.id === "string" && rawMessage.id
            ? rawMessage.id
            : "";
      if (!nodeId) {
        continue;
      }

      const parentId =
        typeof rawMessage.parent_message_uuid === "string"
          ? rawMessage.parent_message_uuid
          : typeof rawMessage.parent_uuid === "string"
            ? rawMessage.parent_uuid
            : typeof rawMessage.parent_message_id === "string"
              ? rawMessage.parent_message_id
              : null;

      const role = mapClaudeSenderToRole(rawMessage.sender);
      const text = getClaudeMessageText(rawMessage);
      const createTime = parseClaudeMessageTime(rawMessage);

      mapping[nodeId] = {
        id: nodeId,
        message: {
          id: nodeId,
          author: {
            role,
            name: null,
            metadata: {}
          },
          create_time: createTime,
          update_time: createTime,
          content: {
            content_type: "text",
            parts: text ? [text] : []
          },
          status: "finished_successfully",
          end_turn: role === "assistant",
          weight: 1.0,
          metadata: {},
          recipient: "all",
          channel: null
        },
        parent: parentId,
        children: []
      };
    }

    for (const node of Object.values(mapping)) {
      if (!node || !node.parent || !mapping[node.parent]) {
        continue;
      }
      mapping[node.parent].children.push(node.id);
    }

    for (const node of Object.values(mapping)) {
      node.children.sort((leftId, rightId) => {
        const leftTime = getNodeCreateTime(mapping, leftId);
        const rightTime = getNodeCreateTime(mapping, rightId);
        if (leftTime !== rightTime) {
          return leftTime - rightTime;
        }
        return String(leftId).localeCompare(String(rightId));
      });
    }

    const allNodeIds = Object.keys(mapping);
    const currentNode = pickBestCurrentNodeForNormalizedMapping(mapping, allNodeIds, payload);

    return {
      title:
        (typeof payload.name === "string" && payload.name) ||
        (typeof payload.title === "string" && payload.title) ||
        "Claude conversation",
      conversation_id: conversationId,
      organization_id: organizationId,
      mapping,
      current_node: currentNode
    };
  }

  function pickBestCurrentNodeForNormalizedMapping(mapping, allNodeIds, payload) {
    const payloadHints = [
      payload && typeof payload.current_leaf_message_uuid === "string" ? payload.current_leaf_message_uuid : "",
      payload && typeof payload.current_message_uuid === "string" ? payload.current_message_uuid : "",
      payload && typeof payload.latest_message_uuid === "string" ? payload.latest_message_uuid : "",
      payload && typeof payload.current_node === "string" ? payload.current_node : ""
    ].filter(Boolean);

    for (const hint of payloadHints) {
      if (mapping[hint]) {
        return hint;
      }
    }

    const leaves = allNodeIds.filter((id) => {
      const children = mapping[id] && Array.isArray(mapping[id].children) ? mapping[id].children : [];
      return children.length === 0;
    });
    const candidates = leaves.length ? leaves : allNodeIds;
    candidates.sort((leftId, rightId) => {
      const leftTime = getNodeCreateTime(mapping, leftId);
      const rightTime = getNodeCreateTime(mapping, rightId);
      if (leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      return String(rightId).localeCompare(String(leftId));
    });

    return candidates[0] || null;
  }

  function mapClaudeSenderToRole(sender) {
    const normalized = typeof sender === "string" ? sender.toLowerCase() : "";
    if (normalized === "human" || normalized === "user") {
      return "user";
    }
    if (normalized === "assistant" || normalized === "model") {
      return "assistant";
    }
    if (normalized === "system") {
      return "system";
    }
    return normalized || "assistant";
  }

  function getClaudeMessageText(message) {
    if (!message || typeof message !== "object") {
      return "";
    }

    const parts = [];

    if (Array.isArray(message.content)) {
      for (const entry of message.content) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        if (entry.type === "text" && typeof entry.text === "string") {
          const value = entry.text.trim();
          if (value) {
            parts.push(value);
          }
        }
      }
    }

    if (!parts.length && typeof message.text === "string") {
      const fallback = message.text.trim();
      if (fallback) {
        parts.push(fallback);
      }
    }

    return parts.join("\n\n").trim();
  }

  function parseClaudeMessageTime(message) {
    if (!message || typeof message !== "object") {
      return Number.POSITIVE_INFINITY;
    }

    const fromIso = [message.created_at, message.updated_at].find((value) => typeof value === "string" && value);
    if (fromIso) {
      const parsed = Date.parse(fromIso);
      if (Number.isFinite(parsed)) {
        return parsed / 1000;
      }
    }

    if (typeof message.index === "number" && Number.isFinite(message.index)) {
      return message.index;
    }

    return Number.POSITIVE_INFINITY;
  }

  async function waitForCapturedConversationViaPageBridge(conversationId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }

      const payload = await getCapturedConversationViaPageBridge(conversationId);
      if (payload) {
        return payload;
      }

      await sleep(Math.min(220, remaining));
    }
    return null;
  }

  async function fetchConversationViaIframeNavigation(conversationId) {
    return new Promise((resolve, reject) => {
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.left = "-99999px";
      iframe.style.top = "0";
      iframe.style.width = "1px";
      iframe.style.height = "1px";
      iframe.style.opacity = "0";
      iframe.style.pointerEvents = "none";
      iframe.setAttribute("aria-hidden", "true");

      let finished = false;
      let timeoutId = 0;

      const cleanup = () => {
        if (finished) {
          return;
        }
        finished = true;
        if (timeoutId) {
          window.clearTimeout(timeoutId);
        }
        iframe.remove();
      };

      const fail = (errorMessage) => {
        cleanup();
        reject(new Error(errorMessage));
      };

      iframe.addEventListener("error", () => {
        fail("Iframe navigation request failed.");
      });

      iframe.addEventListener("load", () => {
        try {
          const frameDocument = iframe.contentDocument;
          if (!frameDocument) {
            fail("Iframe did not expose a readable response document.");
            return;
          }

          const rawText = extractIframeResponseText(frameDocument);
          if (!rawText) {
            fail("Iframe response was empty.");
            return;
          }

          const data = safeParseJson(rawText);
          if (!data || typeof data !== "object") {
            fail("Iframe response was not valid JSON.");
            return;
          }
          if (!data.mapping || typeof data.mapping !== "object") {
            const preview = normalizeWhitespace(rawText).slice(0, 180);
            fail(`Iframe JSON did not contain conversation mapping. Response preview: ${preview || "(empty)"}`);
            return;
          }

          cleanup();
          resolve(data);
        } catch (error) {
          fail(error && error.message ? error.message : "Failed to parse iframe response.");
        }
      });

      timeoutId = window.setTimeout(() => {
        fail("Iframe navigation fetch timed out.");
      }, IFRAME_FETCH_TIMEOUT_MS);

      const iframeUrl = `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(conversationId)}`;
      iframe.src = iframeUrl;

      document.documentElement.appendChild(iframe);
    });
  }

  function extractIframeResponseText(frameDocument) {
    const pre = frameDocument.querySelector("pre");
    if (pre && typeof pre.textContent === "string") {
      const text = pre.textContent.trim();
      if (text) {
        return text;
      }
    }

    if (frameDocument.body && typeof frameDocument.body.textContent === "string") {
      const text = frameDocument.body.textContent.trim();
      if (text) {
        return text;
      }
    }

    if (frameDocument.documentElement && typeof frameDocument.documentElement.textContent === "string") {
      const text = frameDocument.documentElement.textContent.trim();
      if (text) {
        return text;
      }
    }

    return "";
  }

  function safeParseJson(value) {
    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }

  function sendRuntimeMessage(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: "No response received." });
        });
      } catch (error) {
        resolve({ ok: false, error: error.message });
      }
    });
  }

  async function fetchConversationInPage(conversationId) {
    const url = `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(conversationId)}`;
    const response = await fetch(url, {
      method: "GET",
      credentials: "include"
    });

    if (!response.ok) {
      throw new Error(`Conversation request failed (${response.status}).`);
    }

    const data = await response.json();
    if (!data || typeof data !== "object" || !data.mapping) {
      throw new Error("Conversation payload was invalid.");
    }
    return data;
  }

  function clearConversationState() {
    state.data = null;
    state.mapping = null;
    state.rootId = null;
    state.visibleNodes = [];
    state.visibleNodeIds = new Set();
    state.selectedNodeId = null;
    state.searchMatches = [];
    state.searchMatchSet = new Set();
    state.searchIndex = -1;
    state.pendingCapturedRetry = false;
    state.previewResizing = false;
    state.previewResizePointerId = null;
    if (state.ui && state.ui.main) {
      state.ui.main.classList.remove("cgbt-resizing");
    }
    resetTreePan();

    renderTree();
    updateSearchUi();
    clearPreview();
  }

  function setStatus(message, isError) {
    const showError = Boolean(isError) && Boolean(message);
    state.ui.status.hidden = !showError;
    state.ui.status.textContent = showError ? message : "";
    state.ui.status.classList.toggle("cgbt-error", showError);
    state.ui.status.classList.toggle("cgbt-muted", !showError);
  }

  function pickRootNodeId(mapping, currentNodeId) {
    if (currentNodeId && mapping[currentNodeId]) {
      let cursor = currentNodeId;
      const seen = new Set();
      while (
        cursor &&
        mapping[cursor] &&
        mapping[cursor].parent &&
        mapping[mapping[cursor].parent] &&
        !seen.has(cursor)
      ) {
        seen.add(cursor);
        cursor = mapping[cursor].parent;
      }
      if (cursor) {
        return cursor;
      }
    }

    const ids = Object.keys(mapping);
    if (!ids.length) {
      return null;
    }

    const roots = ids.filter((id) => {
      const parent = mapping[id] ? mapping[id].parent : null;
      return !parent || !mapping[parent];
    });

    if (roots.length === 1) {
      return roots[0];
    }

    const withChildren = roots.find((id) => {
      const children = mapping[id] && Array.isArray(mapping[id].children) ? mapping[id].children : [];
      return children.length > 0;
    });

    return withChildren || roots[0] || ids[0];
  }

  function buildVisibleNodeList(mapping, rootId) {
    const userNodeIds = [];
    for (const nodeId of Object.keys(mapping)) {
      const node = mapping[nodeId];
      if (!node || !node.message) {
        continue;
      }

      const role = getNodeRole(node);
      if (role !== "user") {
        continue;
      }

      const userText = getNodeText(node);
      if (!shouldRenderNode(node, role, userText)) {
        continue;
      }

      userNodeIds.push(nodeId);
    }

    const userSet = new Set(userNodeIds);
    const turnMap = new Map();

    for (const userNodeId of userNodeIds) {
      const userNode = mapping[userNodeId];
      const userText = getNodeText(userNode);
      const assistantNodeId = findAssistantResponseNodeId(userNodeId, mapping);
      const assistantText = assistantNodeId && mapping[assistantNodeId] ? getNodeText(mapping[assistantNodeId]) : "";
      const parentTurnId = findParentUserTurnId(userNodeId, mapping, userSet);

      turnMap.set(userNodeId, {
        nodeId: userNodeId,
        userNodeId,
        assistantNodeId: assistantNodeId || null,
        parentTurnId,
        children: [],
        depth: 0,
        branchCount: 0,
        role: "turn",
        userText,
        assistantText: assistantText || "",
        userSnippet: makeSnippet(userText),
        assistantSnippet: assistantText ? makeSnippet(assistantText) : "(no assistant response yet)",
        sortTime: getNodeCreateTime(mapping, userNodeId)
      });
    }

    for (const turn of turnMap.values()) {
      if (turn.parentTurnId && turnMap.has(turn.parentTurnId)) {
        turnMap.get(turn.parentTurnId).children.push(turn.nodeId);
      }
    }

    for (const turn of turnMap.values()) {
      turn.children.sort((leftId, rightId) => compareTurnOrder(leftId, rightId, turnMap));
      turn.branchCount = turn.children.length;
    }

    const rootIds = [];
    for (const turn of turnMap.values()) {
      if (!turn.parentTurnId || !turnMap.has(turn.parentTurnId)) {
        rootIds.push(turn.nodeId);
      }
    }
    rootIds.sort((leftId, rightId) => compareTurnOrder(leftId, rightId, turnMap));

    const orderedTurns = [];
    const visited = new Set();

    const walk = (nodeId, depth) => {
      if (!nodeId || visited.has(nodeId) || !turnMap.has(nodeId)) {
        return;
      }

      visited.add(nodeId);
      const turn = turnMap.get(nodeId);
      turn.depth = depth;
      orderedTurns.push(turn);

      for (const childId of turn.children) {
        walk(childId, depth + 1);
      }
    };

    for (const rootIdValue of rootIds) {
      walk(rootIdValue, 0);
    }

    for (const turnId of turnMap.keys()) {
      if (!visited.has(turnId)) {
        walk(turnId, 0);
      }
    }

    return orderedTurns;
  }

  function findAssistantResponseNodeId(userNodeId, mapping) {
    const userNode = mapping[userNodeId];
    if (!userNode) {
      return null;
    }

    const queue = Array.isArray(userNode.children) ? userNode.children.map((id) => ({ id, depth: 1 })) : [];
    const visited = new Set();

    while (queue.length > 0) {
      const next = queue.shift();
      const nodeId = next.id;
      const depth = next.depth;

      if (!nodeId || visited.has(nodeId)) {
        continue;
      }
      visited.add(nodeId);

      const node = mapping[nodeId];
      if (!node || !node.message) {
        continue;
      }

      const role = getNodeRole(node);
      const text = getNodeText(node);

      if (role === "assistant" && shouldRenderNode(node, role, text)) {
        return nodeId;
      }

      if (role === "user" && depth > 1) {
        continue;
      }

      const children = Array.isArray(node.children) ? node.children : [];
      for (const childId of children) {
        queue.push({ id: childId, depth: depth + 1 });
      }
    }

    return null;
  }

  function findParentUserTurnId(userNodeId, mapping, userSet) {
    let cursor = mapping[userNodeId] ? mapping[userNodeId].parent : null;
    const visited = new Set();

    while (cursor && mapping[cursor] && !visited.has(cursor)) {
      if (userSet.has(cursor)) {
        return cursor;
      }
      visited.add(cursor);
      cursor = mapping[cursor].parent;
    }

    return null;
  }

  function getNodeCreateTime(mapping, nodeId) {
    const node = mapping[nodeId];
    const value = node && node.message ? node.message.create_time : null;
    return typeof value === "number" && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  }

  function compareTurnOrder(leftId, rightId, turnMap) {
    const left = turnMap.get(leftId);
    const right = turnMap.get(rightId);
    if (!left || !right) {
      return String(leftId).localeCompare(String(rightId));
    }

    const leftTime = left.sortTime;
    const rightTime = right.sortTime;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return String(leftId).localeCompare(String(rightId));
  }

  function shouldRenderNode(node, role, text) {
    if (!node || !node.message) {
      return false;
    }

    const metadata = node.message.metadata;
    if (metadata && metadata.is_visually_hidden_from_conversation) {
      return false;
    }

    if (role !== "user" && role !== "assistant") {
      return false;
    }

    return hasMeaningfulNodeText(text);
  }

  function hasMeaningfulNodeText(text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) {
      return false;
    }

    if (/^\(no text content\)$/i.test(normalized)) {
      return false;
    }

    return true;
  }

  function getNodeRole(node) {
    const role = node && node.message && node.message.author ? node.message.author.role : "";
    return typeof role === "string" ? role.toLowerCase() : "unknown";
  }

  function getNodeText(node) {
    const content = node && node.message ? node.message.content : null;
    if (!content) {
      return "";
    }

    if (Array.isArray(content.parts)) {
      return content.parts.map(partToText).filter(Boolean).join("\n").trim();
    }

    if (typeof content.text === "string") {
      return content.text.trim();
    }

    if (typeof content === "string") {
      return content.trim();
    }

    if (typeof content.user_instructions === "string") {
      return content.user_instructions.trim();
    }

    if (typeof content.user_profile === "string") {
      return content.user_profile.trim();
    }

    if (Array.isArray(content)) {
      return content.map(partToText).filter(Boolean).join("\n").trim();
    }

    return "";
  }

  function partToText(part) {
    if (typeof part === "string") {
      return part;
    }
    if (part === null || part === undefined) {
      return "";
    }
    if (typeof part === "number" || typeof part === "boolean") {
      return String(part);
    }
    if (Array.isArray(part)) {
      return part.map(partToText).filter(Boolean).join(" ");
    }
    if (typeof part === "object") {
      if (typeof part.text === "string") {
        return part.text;
      }
      if (typeof part.content === "string") {
        return part.content;
      }
      if (Array.isArray(part.parts)) {
        return part.parts.map(partToText).filter(Boolean).join("\n");
      }
    }
    return "";
  }

  function makeSnippet(text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) {
      return "(no text content)";
    }
    if (normalized.length <= 120) {
      return normalized;
    }
    return `${normalized.slice(0, 117)}...`;
  }

  function normalizeWhitespace(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function renderTree() {
    state.ui.treeCanvas.textContent = "";
    const canvasPadding = getTreeCanvasPadding();

    if (!state.visibleNodes.length) {
      const empty = document.createElement("div");
      empty.className = "cgbt-empty-state";
      empty.textContent = "No complete conversation turns found for this chat.";
      state.ui.treeCanvas.appendChild(empty);
      state.ui.treeCanvas.style.width = "100%";
      state.ui.treeCanvas.style.height = "100%";
      applyTreePanTransform();
      return;
    }

    const layout = buildTreeLayout(state.visibleNodes);
    const nodeWidth = layout.nodeWidth || TREE_NODE_WIDTH;
    const canvasWidth = Math.max(940, layout.width + canvasPadding * 2);
    const canvasHeight = Math.max(620, layout.height + canvasPadding * 2);

    state.ui.treeCanvas.style.width = `${canvasWidth}px`;
    state.ui.treeCanvas.style.height = `${canvasHeight}px`;

    const edgeLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    edgeLayer.setAttribute("class", "cgbt-tree-edges");
    edgeLayer.setAttribute("width", String(canvasWidth));
    edgeLayer.setAttribute("height", String(canvasHeight));

    for (const node of state.visibleNodes) {
      const parentPosition = layout.positions.get(node.nodeId);
      if (!parentPosition) {
        continue;
      }

      for (const childId of node.children) {
        const childPosition = layout.positions.get(childId);
        if (!childPosition) {
          continue;
        }

        const startX = canvasPadding + parentPosition.x;
        const startY = canvasPadding + parentPosition.y + TREE_NODE_HEIGHT;
        const endX = canvasPadding + childPosition.x;
        const endY = canvasPadding + childPosition.y;
        const controlDelta = Math.max(48, (endY - startY) * 0.45);

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute(
          "d",
          `M ${startX} ${startY} C ${startX} ${startY + controlDelta}, ${endX} ${endY - controlDelta}, ${endX} ${endY}`
        );
        path.setAttribute("class", "cgbt-edge-path");
        edgeLayer.appendChild(path);
      }
    }

    state.ui.treeCanvas.appendChild(edgeLayer);

    for (const node of state.visibleNodes) {
      const position = layout.positions.get(node.nodeId);
      if (!position) {
        continue;
      }

      const card = document.createElement("div");
      card.className = "cgbt-node-card";
      card.setAttribute("data-node-id", node.nodeId);
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.style.width = `${Math.round(nodeWidth)}px`;
      card.style.left = `${canvasPadding + position.x - nodeWidth / 2}px`;
      card.style.top = `${canvasPadding + position.y}px`;
      if (!node.parentTurnId) {
        card.classList.add("cgbt-root-turn");
      }

      if (node.nodeId === state.selectedNodeId) {
        card.classList.add("cgbt-selected");
      }
      if (state.searchMatchSet.has(node.nodeId)) {
        card.classList.add("cgbt-search-hit");
      }
      if (state.searchMatches[state.searchIndex] === node.nodeId) {
        card.classList.add("cgbt-search-active");
      }

      const topRow = document.createElement("div");
      topRow.className = "cgbt-node-top";

      const turnTag = document.createElement("span");
      turnTag.className = "cgbt-role cgbt-role-user";
      turnTag.textContent = "turn";
      topRow.appendChild(turnTag);

      if (node.branchCount > 1) {
        const branch = document.createElement("span");
        branch.className = "cgbt-branch-pill";
        branch.textContent = `${node.branchCount} branches`;
        topRow.appendChild(branch);
      }

      const userText = document.createElement("div");
      userText.className = "cgbt-node-snippet cgbt-node-user";
      userText.textContent = `U: ${node.userSnippet}`;

      const assistantText = document.createElement("div");
      assistantText.className = "cgbt-node-snippet cgbt-node-assistant";
      assistantText.textContent = `A: ${node.assistantSnippet}`;

      card.appendChild(topRow);
      card.appendChild(userText);
      card.appendChild(assistantText);
      state.ui.treeCanvas.appendChild(card);
    }

    applyTreePanTransform();
  }

  function buildTreeLayout(nodes) {
    const nodeMap = new Map(nodes.map((node) => [node.nodeId, node]));
    const spacingScale = getTreeSpacingScale();
    const verticalScale = spacingScale * getVerticalSpacingScale();
    const horizontalScale = spacingScale * getHorizontalSpacingScale();
    const layoutNodeWidth = clamp(
      TREE_NODE_WIDTH * (0.45 + horizontalScale * 0.55),
      TREE_NODE_WIDTH * 0.4,
      TREE_NODE_WIDTH
    );
    const siblingGap = TREE_SIBLING_GAP * horizontalScale;
    const levelGap = TREE_LEVEL_GAP * verticalScale;
    const rootGap = TREE_ROOT_GAP * horizontalScale;
    const centerGap = layoutNodeWidth + siblingGap;
    const rootIds = nodes
      .filter((node) => !node.parentTurnId || !nodeMap.has(node.parentTurnId))
      .map((node) => node.nodeId)
      .sort((leftId, rightId) => compareTurnOrder(leftId, rightId, nodeMap));
    const positions = new Map();
    const levels = new Map();
    let maxDepth = 0;

    for (const node of nodes) {
      const depth = Number.isFinite(node.depth) && node.depth >= 0 ? Math.floor(node.depth) : 0;
      if (!levels.has(depth)) {
        levels.set(depth, []);
      }
      levels.get(depth).push(node.nodeId);
      if (depth > maxDepth) {
        maxDepth = depth;
      }
    }

    for (const ids of levels.values()) {
      ids.sort((leftId, rightId) => compareTurnOrder(leftId, rightId, nodeMap));
    }

    const childInfo = new Map();
    for (const node of nodes) {
      const childIds = (node.children || [])
        .filter((childId) => nodeMap.has(childId))
        .sort((leftId, rightId) => compareTurnOrder(leftId, rightId, nodeMap));

      for (let index = 0; index < childIds.length; index += 1) {
        childInfo.set(childIds[index], {
          parentId: node.nodeId,
          index,
          count: childIds.length
        });
      }
    }

    let rootCursor = 0;
    for (const rootIdValue of rootIds) {
      positions.set(rootIdValue, {
        x: rootCursor,
        y: 0
      });
      rootCursor += centerGap + rootGap;
    }

    for (const node of nodes) {
      if (positions.has(node.nodeId)) {
        continue;
      }

      const parentId = node.parentTurnId && nodeMap.has(node.parentTurnId) ? node.parentTurnId : null;
      const parentPosition = parentId ? positions.get(parentId) : null;
      const depth = Number.isFinite(node.depth) && node.depth >= 0 ? Math.floor(node.depth) : 0;

      if (parentPosition) {
        const info = childInfo.get(node.nodeId);
        const count = info ? info.count : 1;
        const index = info ? info.index : 0;
        const centeredIndex = index - (count - 1) / 2;
        positions.set(node.nodeId, {
          x: parentPosition.x + centeredIndex * centerGap,
          y: depth * (TREE_NODE_HEIGHT + levelGap)
        });
      } else {
        positions.set(node.nodeId, {
          x: rootCursor,
          y: depth * (TREE_NODE_HEIGHT + levelGap)
        });
        rootCursor += centerGap + rootGap;
      }
    }

    const resolveDepthOverlaps = (depth) => {
      const ids = levels.get(depth);
      if (!ids || ids.length < 2) {
        return;
      }

      const ordered = ids
        .filter((nodeId) => positions.has(nodeId))
        .sort((leftId, rightId) => {
          const leftPos = positions.get(leftId);
          const rightPos = positions.get(rightId);
          if (!leftPos || !rightPos) {
            return compareTurnOrder(leftId, rightId, nodeMap);
          }
          if (leftPos.x !== rightPos.x) {
            return leftPos.x - rightPos.x;
          }
          return compareTurnOrder(leftId, rightId, nodeMap);
        });

      let previousX = null;
      for (const nodeId of ordered) {
        const position = positions.get(nodeId);
        if (!position) {
          continue;
        }
        if (previousX === null) {
          previousX = position.x;
          continue;
        }
        const minX = previousX + centerGap;
        if (position.x < minX) {
          position.x = minX;
        }
        previousX = position.x;
      }
    };

    for (let depth = 0; depth <= maxDepth; depth += 1) {
      resolveDepthOverlaps(depth);
    }

    for (let iteration = 0; iteration < 2; iteration += 1) {
      for (let depth = maxDepth - 1; depth >= 0; depth -= 1) {
        const ids = levels.get(depth) || [];
        for (const nodeId of ids) {
          const node = nodeMap.get(nodeId);
          const position = positions.get(nodeId);
          if (!node || !position) {
            continue;
          }

          const childIds = (node.children || []).filter((childId) => positions.has(childId));
          if (!childIds.length) {
            continue;
          }

          let sum = 0;
          for (const childId of childIds) {
            const childPosition = positions.get(childId);
            sum += childPosition.x;
          }
          const average = sum / childIds.length;
          const pullStrength = node.parentTurnId && nodeMap.has(node.parentTurnId) ? 0.8 : 0.45;
          position.x = position.x * (1 - pullStrength) + average * pullStrength;
        }
      }

      for (let depth = 0; depth <= maxDepth; depth += 1) {
        resolveDepthOverlaps(depth);
      }
    }

    let minX = Number.POSITIVE_INFINITY;
    let maxX = 0;
    let maxY = 0;
    positions.forEach((position) => {
      minX = Math.min(minX, position.x - layoutNodeWidth / 2);
      maxX = Math.max(maxX, position.x + layoutNodeWidth / 2);
      maxY = Math.max(maxY, position.y + TREE_NODE_HEIGHT);
    });

    if (Number.isFinite(minX) && minX < 0) {
      const offset = -minX;
      positions.forEach((position) => {
        position.x += offset;
      });
      maxX += offset;
    }

    return {
      positions,
      nodeWidth: layoutNodeWidth,
      width: maxX,
      height: maxY
    };
  }

  function pickBestSelectedNode(currentNodeId) {
    if (state.selectedNodeId && state.visibleNodeIds.has(state.selectedNodeId)) {
      return state.selectedNodeId;
    }

    if (currentNodeId && state.visibleNodeIds.has(currentNodeId)) {
      return currentNodeId;
    }

    if (state.visibleNodes.length > 0) {
      return state.visibleNodes[state.visibleNodes.length - 1].nodeId;
    }

    return null;
  }

  function selectNode(nodeId, options = {}) {
    if (!state.mapping || !state.mapping[nodeId]) {
      return;
    }

    state.selectedNodeId = nodeId;
    highlightSelectedNode();
    renderPreview(nodeId);

    if (options.focusTreeNode === false) {
      return;
    }

    const selectedCard = findTreeCardByNodeId(nodeId);
    if (selectedCard) {
      selectedCard.scrollIntoView({ block: "nearest" });
    }
  }

  function clearSelectedNode() {
    if (!state.selectedNodeId && !state.previewVisible) {
      return;
    }
    state.selectedNodeId = null;
    highlightSelectedNode();
    clearPreview();
  }

  function ensurePreviewSelectionConsistency() {
    if (!state.ui) {
      return;
    }

    if (!state.selectedNodeId) {
      if (state.previewVisible) {
        clearPreview();
      }
      return;
    }

    if (!state.visibleNodeIds.has(state.selectedNodeId)) {
      clearSelectedNode();
    }
  }

  function highlightSelectedNode() {
    const cards = state.ui.treeCanvas.querySelectorAll(".cgbt-node-card");
    const activeSearchNodeId = state.searchMatches[state.searchIndex] || null;
    for (const card of cards) {
      const nodeId = card.getAttribute("data-node-id");
      card.classList.toggle("cgbt-selected", nodeId === state.selectedNodeId);
      card.classList.toggle("cgbt-search-hit", state.searchMatchSet.has(nodeId));
      card.classList.toggle("cgbt-search-active", nodeId === activeSearchNodeId);
    }
  }

  function findTreeCardByNodeId(nodeId) {
    const cards = state.ui.treeCanvas.querySelectorAll(".cgbt-node-card");
    for (const card of cards) {
      if (card.getAttribute("data-node-id") === nodeId) {
        return card;
      }
    }
    return null;
  }

  function setSearchQuery(rawQuery) {
    const normalized = normalizeWhitespace(rawQuery).toLowerCase();
    if (normalized === state.searchQuery) {
      updateSearchUi();
      return;
    }

    state.searchQuery = normalized;
    recomputeSearchMatches({ autoSelect: true });
    renderTree();
    highlightSelectedNode();
    if (state.selectedNodeId && state.previewVisible) {
      renderPreview(state.selectedNodeId);
    }
  }

  function recomputeSearchMatches(options = {}) {
    const previousMatches = state.searchMatches;
    const previousIndex = state.searchIndex;
    const previousNodeId =
      previousIndex >= 0 && previousIndex < previousMatches.length
        ? previousMatches[previousIndex]
        : state.selectedNodeId;

    const query = state.searchQuery;
    if (!query || !state.visibleNodes.length) {
      state.searchMatches = [];
      state.searchMatchSet = new Set();
      state.searchIndex = -1;
      updateSearchUi();
      return;
    }

    const tokens = query.split(" ").filter(Boolean);
    const matches = [];

    for (const turn of state.visibleNodes) {
      const haystack = normalizeWhitespace(`${turn.userText}\n${turn.assistantText}`).toLowerCase();
      if (!haystack) {
        continue;
      }
      const isMatch = tokens.every((token) => haystack.includes(token));
      if (isMatch) {
        matches.push(turn.nodeId);
      }
    }

    state.searchMatches = matches;
    state.searchMatchSet = new Set(matches);

    if (!matches.length) {
      state.searchIndex = -1;
      updateSearchUi();
      return;
    }

    const preservedIndex = previousNodeId ? matches.indexOf(previousNodeId) : -1;
    if (preservedIndex >= 0) {
      state.searchIndex = preservedIndex;
    } else {
      state.searchIndex = 0;
    }

    updateSearchUi();

    if (options.autoSelect !== false) {
      activateSearchMatch(state.searchIndex, { panToNode: true });
    }
  }

  function updateSearchUi() {
    if (!state.ui || !state.ui.searchCount || !state.ui.searchPrev || !state.ui.searchNext || !state.ui.searchInput) {
      return;
    }

    const total = state.searchMatches.length;
    const current = total > 0 && state.searchIndex >= 0 ? state.searchIndex + 1 : 0;
    state.ui.searchCount.textContent = `${current} / ${total}`;
    state.ui.searchPrev.disabled = total <= 1;
    state.ui.searchNext.disabled = total <= 1;

    const queryValue = state.ui.searchInput.value || "";
    if (normalizeWhitespace(queryValue).toLowerCase() !== state.searchQuery) {
      state.ui.searchInput.value = state.searchQuery;
    }
  }

  function focusSearchMatchByOffset(offset) {
    const total = state.searchMatches.length;
    if (!total) {
      return;
    }

    const step = offset >= 0 ? 1 : -1;
    const baseIndex = state.searchIndex >= 0 ? state.searchIndex : 0;
    const nextIndex = (baseIndex + step + total) % total;
    activateSearchMatch(nextIndex, { panToNode: true });
  }

  function activateSearchMatch(index, options = {}) {
    const total = state.searchMatches.length;
    if (!total) {
      state.searchIndex = -1;
      updateSearchUi();
      highlightSelectedNode();
      return;
    }

    const boundedIndex = clamp(index, 0, total - 1);
    state.searchIndex = boundedIndex;
    const nodeId = state.searchMatches[boundedIndex];
    if (nodeId && state.visibleNodeIds.has(nodeId)) {
      selectNode(nodeId, { focusTreeNode: false });
      if (options.panToNode !== false) {
        centerTreeNodeInViewport(nodeId);
      }
    }

    updateSearchUi();
    highlightSelectedNode();
  }

  function centerTreeNodeInViewport(nodeId) {
    const card = findTreeCardByNodeId(nodeId);
    if (!card || !state.ui || !state.ui.treeViewport) {
      return;
    }

    const viewportRect = state.ui.treeViewport.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const viewportCenterX = viewportRect.left + viewportRect.width / 2;
    const viewportCenterY = viewportRect.top + viewportRect.height / 2;
    const cardCenterX = cardRect.left + cardRect.width / 2;
    const cardCenterY = cardRect.top + cardRect.height / 2;
    state.panX += viewportCenterX - cardCenterX;
    state.panY += viewportCenterY - cardCenterY;
    applyTreePanTransform();
  }

  function renderPreview(nodeId) {
    const pair = getPreviewPair(nodeId, state.mapping);
    if (!pair) {
      clearPreview();
      return;
    }

    const canOpenBranch = state.provider === "chatgpt" || state.provider === "claude";

    state.ui.previewTitle.textContent = `Branch Preview (${shortId(nodeId)})`;
    renderPreviewTextWithSearchHighlights(state.ui.previewMessage, pair.messageText);
    renderPreviewTextWithSearchHighlights(state.ui.previewResponse, pair.responseText);
    state.ui.previewEmpty.hidden = true;
    state.ui.previewContent.hidden = false;
    setPreviewVisible(true);
    state.ui.openBranch.hidden = !canOpenBranch;
    state.ui.openBranch.disabled = !canOpenBranch;
  }

  function clearPreview() {
    const canOpenBranch = state.provider === "chatgpt" || state.provider === "claude";
    state.ui.previewTitle.textContent = "Branch Preview";
    state.ui.previewMessage.textContent = "";
    state.ui.previewResponse.textContent = "";
    state.ui.previewEmpty.hidden = false;
    state.ui.previewContent.hidden = true;
    setPreviewVisible(false);
    state.ui.openBranch.hidden = !canOpenBranch;
    state.ui.openBranch.disabled = true;
  }

  function setPreviewVisible(visible) {
    state.previewVisible = visible;
    state.ui.main.classList.toggle("cgbt-preview-open", visible);
    state.ui.main.classList.toggle("cgbt-preview-closed", !visible);
    state.ui.previewSection.hidden = !visible;
    state.ui.previewSection.style.display = visible ? "flex" : "none";
    applyPreviewSplit();
  }

  function renderPreviewTextWithSearchHighlights(element, text) {
    if (!element) {
      return;
    }

    const content = String(text || "");
    const query = state.searchQuery;
    if (!query) {
      element.textContent = content;
      return;
    }

    element.innerHTML = highlightTextHtml(content, query);
  }

  function highlightTextHtml(text, query) {
    const content = String(text || "");
    const tokens = Array.from(new Set(String(query || "").split(" ").filter(Boolean))).sort(
      (left, right) => right.length - left.length
    );
    if (!tokens.length) {
      return escapeHtml(content);
    }

    const matcher = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
    let result = "";
    let lastIndex = 0;
    let match = matcher.exec(content);
    while (match) {
      result += escapeHtml(content.slice(lastIndex, match.index));
      result += `<mark class="cgbt-search-mark">${escapeHtml(match[0])}</mark>`;
      lastIndex = match.index + match[0].length;
      match = matcher.exec(content);
    }
    result += escapeHtml(content.slice(lastIndex));
    return result;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getPreviewPair(nodeId, mapping) {
    const selected = mapping[nodeId];
    if (!selected) {
      return null;
    }

    const selectedRole = getNodeRole(selected);
    let messageNode = selected;
    let responseNode = null;

    if (selectedRole === "assistant") {
      responseNode = selected;
      if (selected.parent && mapping[selected.parent] && getNodeRole(mapping[selected.parent]) === "user") {
        messageNode = mapping[selected.parent];
      }
    } else if (selectedRole === "user") {
      const responseId = findAssistantDescendant(nodeId, mapping);
      if (responseId && mapping[responseId]) {
        responseNode = mapping[responseId];
      }
    } else {
      const responseId = findAssistantDescendant(nodeId, mapping);
      if (responseId && mapping[responseId]) {
        responseNode = mapping[responseId];
      }
    }

    const messageText = getNodeText(messageNode) || "(Message has no text content.)";
    const responseText = responseNode
      ? getNodeText(responseNode) || "(Assistant response has no text content.)"
      : "(No assistant response found for this branch node.)";

    return { messageText, responseText };
  }

  function findAssistantDescendant(startNodeId, mapping) {
    const start = mapping[startNodeId];
    if (!start) {
      return null;
    }

    const queue = Array.isArray(start.children) ? [...start.children] : [];
    const visited = new Set();

    while (queue.length > 0) {
      const nextId = queue.shift();
      if (!nextId || visited.has(nextId)) {
        continue;
      }
      visited.add(nextId);

      const node = mapping[nextId];
      if (!node) {
        continue;
      }
      if (getNodeRole(node) === "assistant") {
        return nextId;
      }

      const children = Array.isArray(node.children) ? node.children : [];
      for (const childId of children) {
        queue.push(childId);
      }
    }

    return null;
  }

  async function navigateToSelectedBranch() {
    if (!state.mapping || !state.selectedNodeId || state.navigating) {
      return;
    }
    if (state.provider !== "chatgpt" && state.provider !== "claude") {
      setStatus("Open branch is not supported for this provider.", true);
      return;
    }

    const targetNodeId = state.selectedNodeId;
    const turnPath = buildTurnPathToNode(targetNodeId, state.visibleNodes);
    if (turnPath.length === 0) {
      setStatus("Could not compute branch path for selected node.", true);
      return;
    }

    state.navigating = true;
    state.ui.openBranch.disabled = true;
    setStatus("", false);

    try {
      const result = await replayTurnPathThroughUi(turnPath);
      if (result.ok) {
        setStatus("", false);
      } else {
        setStatus(`Navigation incomplete: ${result.reason}`, true);
      }
    } catch (error) {
      setStatus(`Navigation failed: ${error.message}`, true);
    } finally {
      state.navigating = false;
      state.ui.openBranch.disabled = false;
    }
  }

  function buildTurnPathToNode(targetNodeId, visibleNodes) {
    const turnMap = new Map();
    for (const turn of visibleNodes) {
      turnMap.set(turn.nodeId, turn);
    }
    if (!turnMap.has(targetNodeId)) {
      return [];
    }

    const path = [];
    let cursor = targetNodeId;
    const seen = new Set();

    while (cursor && turnMap.has(cursor) && !seen.has(cursor)) {
      path.push(turnMap.get(cursor));
      seen.add(cursor);
      const nextParent = turnMap.get(cursor).parentTurnId;
      cursor = nextParent && turnMap.has(nextParent) ? nextParent : null;
    }

    path.reverse();
    return path;
  }

  async function replayTurnPathThroughUi(turnPath) {
    const turnById = new Map(state.visibleNodes.map((turn) => [turn.nodeId, turn]));

    for (let index = 0; index < turnPath.length - 1; index += 1) {
      const parentTurn = turnPath[index];
      const childTurn = turnPath[index + 1];
      const children = Array.isArray(parentTurn.children) ? parentTurn.children : [];
      if (children.length <= 1) {
        continue;
      }

      const targetIndex = children.indexOf(childTurn.nodeId);
      if (targetIndex < 0) {
        continue;
      }

      const childTurns = children
        .map((childId) => turnById.get(childId))
        .filter(Boolean);
      const anchorSelection = await findBranchAnchorForParent(parentTurn, childTurns);
      if (!anchorSelection || !anchorSelection.element) {
        return {
          ok: false,
          reason: "Could not locate one parent message block in the rendered chat."
        };
      }

      const anchor = anchorSelection.element;
      const snippet = anchorSelection.snippet;
      const role = anchorSelection.role;
      anchor.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(200);

      const switched = await setVariantToRevealChild(anchor, snippet, role, targetIndex, childTurn);
      if (!switched) {
        return {
          ok: false,
          reason: "Could not set one branch selector to the expected variant."
        };
      }

      const childVisible = await waitForTurnVisible(childTurn, DOM_SEARCH_TIMEOUT_MS);
      if (!childVisible) {
        return {
          ok: false,
          reason: "A child branch did not become visible after branch switching."
        };
      }

      await sleep(220);
    }

    const targetTurn = turnPath[turnPath.length - 1];
    const targetElement = await waitForTurnVisible(targetTurn, 1_200);
    if (targetElement) {
      targetElement.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    return { ok: true };
  }

  async function findBranchAnchorForParent(parentTurn, childTurns) {
    const role = "user";
    const siblings = Array.isArray(childTurns) ? childTurns : [];

    const quickDeadline = Date.now() + 1_300;
    while (Date.now() < quickDeadline) {
      for (const sibling of siblings) {
        const siblingSnippet = createDomSearchSnippet(sibling.userText || sibling.userSnippet || "");
        if (!siblingSnippet) {
          continue;
        }
        const siblingAnchor = findMessageElement(siblingSnippet, role);
        if (siblingAnchor) {
          return {
            element: siblingAnchor,
            snippet: siblingSnippet,
            role
          };
        }
      }
      await sleep(130);
    }

    const parentSnippet = createDomSearchSnippet(parentTurn.userText || parentTurn.userSnippet || "");
    if (!parentSnippet) {
      return null;
    }
    const parentAnchor = await waitForMessageElement(parentSnippet, role, DOM_SEARCH_TIMEOUT_MS);
    if (!parentAnchor) {
      return null;
    }
    return {
      element: parentAnchor,
      snippet: parentSnippet,
      role
    };
  }

  async function waitForTurnVisible(turn, timeoutMs) {
    if (!turn) {
      return null;
    }
    const snippet = createDomSearchSnippet(turn.userText || turn.userSnippet || "");
    if (!snippet) {
      return null;
    }
    return waitForMessageElement(snippet, "user", timeoutMs, { allowScrollScan: false });
  }

  async function setVariantToRevealChild(anchor, snippet, role, preferredIndex, childTurn) {
    const totalVariants = getVariantTotalNearAnchor(anchor, snippet, role);
    if (!Number.isFinite(totalVariants) || totalVariants <= 1) {
      return false;
    }

    const candidateIndexes = [];
    if (Number.isInteger(preferredIndex) && preferredIndex >= 0 && preferredIndex < totalVariants) {
      candidateIndexes.push(preferredIndex);
    }

    for (let index = 0; index < totalVariants; index += 1) {
      if (!candidateIndexes.includes(index)) {
        candidateIndexes.push(index);
      }
    }

    for (const index of candidateIndexes) {
      const switched = await setVariantIndexNearAnchor(anchor, snippet, role, index);
      if (!switched) {
        continue;
      }
      const childVisible = await waitForTurnVisible(childTurn, 900);
      if (childVisible) {
        return true;
      }
      await sleep(120);
    }

    return false;
  }

  function getVariantTotalNearAnchor(anchor, snippet, role) {
    const refreshedAnchor = findMessageElement(snippet, role) || anchor;
    const variantControls = findVariantControls(refreshedAnchor);
    if (!variantControls || !variantControls.counter) {
      return 0;
    }
    const parsed = parseVariantCounter(variantControls.counter.textContent || "");
    if (!parsed || !Number.isFinite(parsed.total)) {
      return 0;
    }
    return parsed.total;
  }

  function createDomSearchSnippet(text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) {
      return "";
    }
    const words = normalized.split(" ").filter(Boolean);
    return words.slice(0, 26).join(" ").slice(0, 180);
  }

  async function waitForMessageElement(snippet, role, timeoutMs, options = {}) {
    const deadline = Date.now() + timeoutMs;
    const immediate = findMessageElement(snippet, role);
    if (immediate) {
      return immediate;
    }

    if (options.allowScrollScan !== false) {
      const scanned = await scanForMessageElementByScrolling(snippet, role, deadline);
      if (scanned) {
        return scanned;
      }
    }

    while (Date.now() < deadline) {
      const element = findMessageElement(snippet, role);
      if (element) {
        return element;
      }
      await sleep(180);
    }
    return null;
  }

  function findMessageElement(snippet, role) {
    const searchRoot = getConversationSearchRoot();
    if (!searchRoot) {
      return null;
    }

    const snippetNormalized = normalizeWhitespace(snippet).toLowerCase();
    const snippetShort = snippetNormalized.slice(0, 80);
    const snippetWords = snippetShort.split(" ").filter((word) => word.length > 2);
    const snippetPrefix = snippetWords.slice(0, Math.min(6, snippetWords.length)).join(" ");
    const candidates = searchRoot.querySelectorAll(
      [
        "article",
        "[data-message-author-role]",
        ".group",
        "[data-testid='user-message']",
        "[data-testid='assistant-message']",
        ".font-user-message"
      ].join(", ")
    );

    let best = null;
    let bestScore = -Infinity;

    for (const candidate of candidates) {
      if (candidate.closest("#cgbt-root")) {
        continue;
      }

      if (!isVisible(candidate)) {
        continue;
      }

      const candidateText = normalizeWhitespace(candidate.innerText || candidate.textContent || "").toLowerCase();
      if (!candidateText) {
        continue;
      }

      let score = 0;
      if (snippetShort) {
        if (candidateText.includes(snippetShort)) {
          score += 8;
        } else {
          const overlap = overlappingWordCount(snippetShort, candidateText);
          const minOverlap = Math.min(5, Math.max(2, Math.ceil(snippetWords.length * 0.34)));
          const prefixMatched = snippetPrefix && candidateText.includes(snippetPrefix);
          if (!prefixMatched && overlap < minOverlap) {
            continue;
          }
          score += overlap + (prefixMatched ? 3 : 0);
        }
      } else {
        score += 1;
      }

      const authorRole = inferElementRole(candidate);
      if (role && authorRole) {
        if (authorRole !== role) {
          continue;
        }
        score += 3;
      }

      score -= Math.min(2, candidateText.length / 3_600);

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    if (!best) {
      return null;
    }

    const minimumScore = snippetShort ? (state.provider === "claude" ? 0.6 : 1) : 0;
    return bestScore > minimumScore ? best : null;
  }

  function getConversationSearchRoot() {
    return document.querySelector("main") || document.body;
  }

  async function scanForMessageElementByScrolling(snippet, role, deadline) {
    const containers = getConversationScrollContainers();
    if (!containers.length) {
      return null;
    }

    const step = Math.max(260, Math.round(window.innerHeight * DOM_SEARCH_SCROLL_STEP_RATIO));
    for (const container of containers) {
      if (Date.now() >= deadline) {
        return null;
      }

      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      if (maxTop <= 0) {
        continue;
      }

      const startTop = container.scrollTop;
      const positions = buildScrollProbePositions(startTop, maxTop, step);

      for (const position of positions) {
        if (Date.now() >= deadline) {
          break;
        }

        container.scrollTop = position;
        await sleep(DOM_SEARCH_SCROLL_DELAY_MS);
        const found = findMessageElement(snippet, role);
        if (found) {
          return found;
        }
      }

      container.scrollTop = startTop;
    }

    return null;
  }

  function getConversationScrollContainers() {
    const containers = [];
    const seen = new Set();

    const push = (element) => {
      if (!element || seen.has(element) || !isScrollableContainer(element)) {
        return;
      }
      seen.add(element);
      containers.push(element);
    };

    push(document.scrollingElement);
    push(document.documentElement);
    push(document.body);

    const main = document.querySelector("main");
    if (main) {
      push(main);
      let cursor = main;
      for (let index = 0; cursor && index < 8; index += 1) {
        push(cursor);
        cursor = cursor.parentElement;
      }
    }

    const explicitSelectors = [
      "[data-testid='chat-messages']",
      "[data-testid='conversation']",
      "[data-testid='chat-conversation']",
      "[data-testid='conversation-view']",
      "[data-testid='chat-view']",
      "[role='main']",
      "div[class*='overflow-y-auto']",
      "div[class*='overflow-auto']"
    ];

    for (const selector of explicitSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        push(element);
      }
    }

    return containers;
  }

  function isScrollableContainer(element) {
    if (!element || typeof element.scrollTop !== "number") {
      return false;
    }
    if (element.scrollHeight <= element.clientHeight + 40) {
      return false;
    }

    if (
      element === document.scrollingElement ||
      element === document.documentElement ||
      element === document.body
    ) {
      return true;
    }

    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY || "";
    return /(auto|scroll|overlay)/i.test(overflowY);
  }

  function buildScrollProbePositions(startTop, maxTop, step) {
    const positions = [startTop, 0, maxTop];

    for (let value = startTop - step; value > 0; value -= step) {
      positions.push(value);
    }
    for (let value = startTop + step; value < maxTop; value += step) {
      positions.push(value);
    }
    for (let value = 0; value < maxTop; value += step) {
      positions.push(value);
    }
    positions.push(maxTop);

    const unique = [];
    const seen = new Set();
    for (const value of positions) {
      const rounded = Math.round(clamp(value, 0, maxTop));
      if (seen.has(rounded)) {
        continue;
      }
      seen.add(rounded);
      unique.push(rounded);
    }

    return unique;
  }

  function inferElementRole(element) {
    if (!element) {
      return "";
    }

    const explicitRole = (element.getAttribute("data-message-author-role") || "").toLowerCase();
    if (explicitRole) {
      return explicitRole;
    }

    const testId = (element.getAttribute("data-testid") || "").toLowerCase();
    if (testId.includes("user-message") || testId.includes("human-message")) {
      return "user";
    }
    if (testId.includes("assistant-message") || testId.includes("model-message")) {
      return "assistant";
    }

    return "";
  }

  function overlappingWordCount(source, target) {
    const words = Array.from(new Set(source.split(" ").filter((word) => word.length > 3))).slice(0, 8);
    let count = 0;
    for (const word of words) {
      if (target.includes(word)) {
        count += 1;
      }
    }
    return count;
  }

  async function setVariantIndexNearAnchor(anchor, snippet, role, targetIndex) {
    const maxClicks = 36;
    for (let attempt = 0; attempt < maxClicks; attempt += 1) {
      const refreshedAnchor = findMessageElement(snippet, role) || anchor;
      const variantControls = findVariantControls(refreshedAnchor);
      if (!variantControls) {
        return false;
      }

      const parsedCounter = parseVariantCounter(variantControls.counter.textContent || "");
      if (!parsedCounter || parsedCounter.total <= 1) {
        return false;
      }

      const boundedTarget = clamp(targetIndex, 0, parsedCounter.total - 1);
      if (parsedCounter.current === boundedTarget) {
        return true;
      }

      if (parsedCounter.current < boundedTarget) {
        if (!variantControls.next) {
          return false;
        }
        variantControls.next.click();
      } else {
        if (!variantControls.prev) {
          return false;
        }
        variantControls.prev.click();
      }

      await sleep(NAV_CLICK_DELAY_MS);
    }

    return false;
  }

  function findVariantControls(anchor) {
    const scopes = collectCandidateScopes(anchor);
    for (const scope of scopes) {
      const counters = findVariantCounters(scope);
      for (const counter of counters) {
        const parsed = parseVariantCounter(counter.textContent || "");
        if (!parsed || parsed.total <= 1) {
          continue;
        }

        const buttons = findVariantButtons(scope, counter);
        if (buttons.prev || buttons.next) {
          return {
            counter,
            prev: buttons.prev,
            next: buttons.next
          };
        }
      }
    }
    return null;
  }

  function collectCandidateScopes(anchor) {
    const scopes = [];
    const seen = new Set();

    const push = (element) => {
      if (!element || seen.has(element)) {
        return;
      }
      seen.add(element);
      scopes.push(element);
    };

    push(anchor);
    if (anchor) {
      push(anchor.closest("article"));
      push(anchor.closest("[data-message-author-role]"));
      push(anchor.closest("[data-testid='user-message']"));
      push(anchor.closest("[data-testid='assistant-message']"));
    }

    let cursor = anchor;
    for (let index = 0; cursor && index < 10; index += 1) {
      push(cursor);
      cursor = cursor.parentElement;
    }

    push(document.querySelector("main"));
    push(document.body);

    return scopes;
  }

  function findVariantCounters(scope) {
    const counters = [];
    const potential = scope.querySelectorAll("span, div, p, strong");
    for (const node of potential) {
      if (!isVisible(node)) {
        continue;
      }
      const text = normalizeWhitespace(node.textContent);
      if (/^\d+\s*(\/|of)\s*\d+$/i.test(text)) {
        counters.push(node);
      }
    }
    return counters;
  }

  function findVariantButtons(scope, counter) {
    const buttons = Array.from(scope.querySelectorAll("button")).filter(isVisible);
    if (!buttons.length) {
      return { prev: null, next: null };
    }

    let prev = null;
    let next = null;

    for (const button of buttons) {
      const fingerprint = buttonFingerprint(button);
      if (!prev && /\b(previous|prev|left)\b/i.test(fingerprint)) {
        prev = button;
      }
      if (!next && /\b(next|right)\b/i.test(fingerprint)) {
        next = button;
      }
    }

    if (prev && next) {
      return { prev, next };
    }

    const ranked = buttons
      .map((button) => ({
        button,
        distance: elementDistance(button, counter),
        x: button.getBoundingClientRect().left
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 6)
      .sort((a, b) => a.x - b.x);

    if (!prev && ranked.length > 0) {
      prev = ranked[0].button;
    }
    if (!next && ranked.length > 1) {
      next = ranked[ranked.length - 1].button;
    }
    if (prev && next && prev === next) {
      next = null;
    }

    return { prev, next };
  }

  function buttonFingerprint(button) {
    const aria = button.getAttribute("aria-label") || "";
    const title = button.getAttribute("title") || "";
    const text = normalizeWhitespace(button.textContent || "");
    return `${aria} ${title} ${text}`.toLowerCase();
  }

  function elementDistance(a, b) {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    const aCenterX = aRect.left + aRect.width / 2;
    const aCenterY = aRect.top + aRect.height / 2;
    const bCenterX = bRect.left + bRect.width / 2;
    const bCenterY = bRect.top + bRect.height / 2;
    const dx = aCenterX - bCenterX;
    const dy = aCenterY - bCenterY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function parseVariantCounter(text) {
    const normalized = normalizeWhitespace(text).toLowerCase();
    const match = normalized.match(/(\d+)\s*(?:\/|of)\s*(\d+)/i);
    if (!match) {
      return null;
    }
    const currentOneBased = Number.parseInt(match[1], 10);
    const total = Number.parseInt(match[2], 10);
    if (!Number.isFinite(currentOneBased) || !Number.isFinite(total) || total <= 0) {
      return null;
    }
    return {
      current: clamp(currentOneBased - 1, 0, Math.max(0, total - 1)),
      total
    };
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function shortId(value) {
    if (!value) {
      return "";
    }
    return value.length <= 12 ? value : `${value.slice(0, 8)}...`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
