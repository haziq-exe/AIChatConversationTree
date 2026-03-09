const CACHE_TTL_MS = 15_000;
const conversationCache = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    sendResponse({ ok: false, error: "Invalid message payload." });
    return false;
  }

  if (message.type === "CGBT_FETCH_CONVERSATION") {
    const conversationId = typeof message.conversationId === "string" ? message.conversationId : "";
    const force = Boolean(message.force);

    fetchConversation(conversationId, force)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message.type === "CGBT_CLEAR_CACHE") {
    conversationCache.clear();
    sendResponse({ ok: true });
    return false;
  }

  sendResponse({ ok: false, error: `Unsupported message type: ${message.type}` });
  return false;
});

async function fetchConversation(conversationId, force) {
  if (!conversationId) {
    throw new Error("Conversation id is missing.");
  }

  const cached = conversationCache.get(conversationId);
  const now = Date.now();
  if (!force && cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const url = `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(conversationId)}`;
  const response = await fetch(url, {
    method: "GET",
    credentials: "include"
  });

  if (!response.ok) {
    throw new Error(`Backend fetch failed (${response.status}).`);
  }

  const data = await response.json();
  if (!data || typeof data !== "object" || !data.mapping) {
    throw new Error("Conversation payload is missing mapping.");
  }

  conversationCache.set(conversationId, {
    timestamp: now,
    data
  });

  if (conversationCache.size > 30) {
    trimOldCacheEntries();
  }

  return data;
}

function trimOldCacheEntries() {
  const entries = Array.from(conversationCache.entries()).sort(
    (a, b) => a[1].timestamp - b[1].timestamp
  );

  for (let index = 0; index < entries.length - 20; index += 1) {
    conversationCache.delete(entries[index][0]);
  }
}
