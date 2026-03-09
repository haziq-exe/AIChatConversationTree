(() => {
  if (window.__CGBT_PAGE_BRIDGE_LOADED__) {
    return;
  }
  window.__CGBT_PAGE_BRIDGE_LOADED__ = true;

  const SOURCE_CONTENT = "CGBT_CONTENT";
  const SOURCE_PAGE = "CGBT_PAGE";
  const MAX_CAPTURED_CONVERSATIONS = 40;

  const capturedConversations = new Map();

  patchFetch();
  patchXmlHttpRequest();

  window.addEventListener("message", async (event) => {
    if (event.source !== window) {
      return;
    }

    const message = event.data;
    if (!message || typeof message !== "object" || message.source !== SOURCE_CONTENT) {
      return;
    }

    if (message.type !== "CGBT_PAGE_FETCH_CONVERSATION") {
      if (message.type === "CGBT_PAGE_GET_CAPTURED_CONVERSATION") {
        const requestId = typeof message.requestId === "string" ? message.requestId : "";
        const conversationId = typeof message.conversationId === "string" ? message.conversationId : "";
        if (!requestId) {
          return;
        }

        const capturedEntry = capturedConversations.get(conversationId);
        window.postMessage(
          {
            source: SOURCE_PAGE,
            type: "CGBT_PAGE_GET_CAPTURED_RESULT",
            requestId,
            ok: true,
            found: Boolean(capturedEntry),
            data: capturedEntry ? capturedEntry.data : null
          },
          "*"
        );
      }
      return;
    }

    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    const conversationId = typeof message.conversationId === "string" ? message.conversationId : "";

    if (!requestId) {
      return;
    }

    if (!conversationId) {
      window.postMessage(
        {
          source: SOURCE_PAGE,
          type: "CGBT_PAGE_FETCH_RESULT",
          requestId,
          ok: false,
          error: "Conversation id is missing."
        },
        "*"
      );
      return;
    }

    const url = `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(conversationId)}`;

    try {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include"
      });

      const responseText = await response.text();
      let data = null;

      if (responseText) {
        try {
          data = JSON.parse(responseText);
        } catch (_error) {
          data = null;
        }
      }

      const payloadLooksValid = Boolean(data && typeof data === "object" && data.mapping);
      const ok = response.ok && payloadLooksValid;

      if (ok) {
        storeConversationCapture(url, data, "direct-fetch");
      }

      window.postMessage(
        {
          source: SOURCE_PAGE,
          type: "CGBT_PAGE_FETCH_RESULT",
          requestId,
          ok,
          status: response.status,
          error: ok
            ? null
            : response.ok
              ? "Conversation payload was invalid."
              : `Conversation request failed (${response.status}).`,
          data
        },
        "*"
      );
    } catch (error) {
      window.postMessage(
        {
          source: SOURCE_PAGE,
          type: "CGBT_PAGE_FETCH_RESULT",
          requestId,
          ok: false,
          error: error && error.message ? error.message : "Unknown page-bridge fetch error."
        },
        "*"
      );
    }
  });

  function patchFetch() {
    if (typeof window.fetch !== "function") {
      return;
    }

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      void captureConversationFromFetch(args, response);
      return response;
    };
  }

  async function captureConversationFromFetch(args, response) {
    try {
      const url = getRequestUrl(args[0]);
      if (!isConversationEndpoint(url)) {
        return;
      }

      const cloned = response.clone();
      const text = await cloned.text();
      if (!text) {
        return;
      }

      const data = safeParseJson(text);
      if (!data || typeof data !== "object" || !data.mapping) {
        return;
      }

      storeConversationCapture(url, data, "fetch");
    } catch (_error) {
      // no-op
    }
  }

  function patchXmlHttpRequest() {
    if (typeof XMLHttpRequest === "undefined") {
      return;
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__cgbtUrl = typeof url === "string" ? url : String(url || "");
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function patchedSend(...args) {
      this.addEventListener("loadend", () => {
        try {
          const url = typeof this.__cgbtUrl === "string" && this.__cgbtUrl ? this.__cgbtUrl : this.responseURL;
          if (!isConversationEndpoint(url)) {
            return;
          }
          if (typeof this.responseText !== "string" || !this.responseText) {
            return;
          }

          const data = safeParseJson(this.responseText);
          if (!data || typeof data !== "object" || !data.mapping) {
            return;
          }

          storeConversationCapture(url, data, "xhr");
        } catch (_error) {
          // no-op
        }
      });

      return originalSend.apply(this, args);
    };
  }

  function storeConversationCapture(url, data, via) {
    if (!data || typeof data !== "object" || !data.mapping) {
      return;
    }

    const conversationId = deriveConversationId(url, data);
    if (!conversationId) {
      return;
    }

    capturedConversations.set(conversationId, {
      data,
      timestamp: Date.now(),
      via
    });

    if (capturedConversations.size > MAX_CAPTURED_CONVERSATIONS) {
      trimCapturedConversations();
    }

    window.postMessage(
      {
        source: SOURCE_PAGE,
        type: "CGBT_PAGE_CAPTURED_CONVERSATION",
        conversationId,
        via,
        nodeCount: Object.keys(data.mapping || {}).length
      },
      "*"
    );
  }

  function trimCapturedConversations() {
    const entries = Array.from(capturedConversations.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    );
    const toDelete = entries.length - Math.floor(MAX_CAPTURED_CONVERSATIONS * 0.7);
    for (let index = 0; index < toDelete; index += 1) {
      capturedConversations.delete(entries[index][0]);
    }
  }

  function getRequestUrl(arg) {
    if (typeof arg === "string") {
      return arg;
    }
    if (arg && typeof arg.url === "string") {
      return arg.url;
    }
    return "";
  }

  function isConversationEndpoint(url) {
    return typeof url === "string" && /\/backend-api\/conversation\/[^/?#]+/.test(url);
  }

  function deriveConversationId(url, data) {
    if (data && typeof data.conversation_id === "string" && data.conversation_id) {
      return data.conversation_id;
    }

    const match = String(url || "").match(/\/backend-api\/conversation\/([^/?#]+)/);
    if (!match) {
      return "";
    }

    try {
      return decodeURIComponent(match[1]);
    } catch (_error) {
      return match[1];
    }
  }

  function safeParseJson(value) {
    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }
})();
