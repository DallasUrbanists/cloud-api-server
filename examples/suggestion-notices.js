/**
 * Browser integration helper. Copy into your web app; no Node dependencies.
 * Callbacks must honor signal.aborted before applying asynchronously fetched data.
 */
export function connectSuggestionNotices({
  url, getCredentials, refreshAll, refreshSuggestions, onAuthenticationRequired = () => {},
  createSocket = url => new WebSocket(url),
}) {
  let stopped = false;
  let socket;
  let retry;
  let attempt = 0;
  let generation = 0;
  let controller;

  function connect() {
    if (stopped) return;
    const current = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    const ws = socket = createSocket(url);
    const dirty = new Set();
    let ready = false;
    let refreshing = false;
    let debounce;
    const active = () => !stopped && generation === current && !signal.aborted;
    const failed = () => { if (active()) ws.close(1013, 'Refresh failed'); };

    async function flush() {
      if (!active() || !ready || refreshing || !dirty.size) return;
      refreshing = true;
      const ids = [...dirty];
      dirty.clear();
      try { await refreshSuggestions(ids, signal); }
      catch { failed(); }
      finally {
        refreshing = false;
        if (active() && dirty.size) debounce = setTimeout(flush, 100);
      }
    }
    ws.addEventListener('open', async () => {
      try {
        const credentials = await getCredentials();
        if (active() && ws.readyState === 1) ws.send(JSON.stringify({ type: 'authenticate', ...credentials }));
      } catch {
        if (active()) ws.close(4001, 'Refresh application credentials.');
      }
    });
    ws.addEventListener('message', async event => {
      if (!active()) return;
      let notice;
      try { notice = JSON.parse(event.data); }
      catch { failed(); return; }
      if (notice.type === 'ready' && !ready) {
        ready = true;
        refreshing = true;
        try {
          await refreshAll(signal);
          if (active()) attempt = 0;
        } catch { failed(); }
        finally {
          refreshing = false;
          if (active()) debounce = setTimeout(flush, 100);
        }
      } else if (['suggestion.created', 'suggestion.updated', 'suggestion.deleted'].includes(notice.type)
        && Number.isSafeInteger(notice.suggestionId) && notice.suggestionId > 0) {
        dirty.add(notice.suggestionId);
        clearTimeout(debounce);
        if (ready && !refreshing) debounce = setTimeout(flush, 100);
      }
    });
    ws.addEventListener('close', event => {
      clearTimeout(debounce);
      if (!active()) return;
      controller.abort();
      if ([4000, 4001, 1008, 1009].includes(event.code)) {
        stopped = true;
        onAuthenticationRequired(event.code);
        return;
      }
      // Equal jitter, always between one and thirty seconds.
      const ceiling = Math.min(30000, 2000 * 2 ** Math.min(attempt++, 4));
      retry = setTimeout(connect, Math.max(1000, ceiling * (0.5 + Math.random() * 0.5)));
    });
  }
  connect();
  return {
    stop() {
      stopped = true;
      generation++;
      clearTimeout(retry);
      controller?.abort();
      socket?.close(1000, 'Client stopped.');
    },
  };
}
