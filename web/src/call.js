// Backend socket plus the Vonage Video call.

/**
 * Opens the room socket, reconnecting if it drops.
 * onStatus(text)  "connecting" | "open" | "retrying"
 */
export function connectBackend(code, onMessage, onStatus) {
  const base = import.meta.env.VITE_API || "ws://localhost:8000/ws";
  const url = `${base}/${encodeURIComponent(code)}`;

  let ws;
  let closed = false;
  let attempts = 0;

  // A live handle whose .send always points at the current socket, so callers
  // never hold a reference to a dead one.
  const handle = {
    send(data) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    get readyState() {
      return ws ? ws.readyState : WebSocket.CLOSED;
    },
    close() {
      closed = true;
      ws?.close();
    },
  };

  function open() {
    onStatus?.(attempts === 0 ? "connecting" : "retrying");
    ws = new WebSocket(url);

    ws.onopen = () => { attempts = 0; onStatus?.("open"); };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));

    ws.onclose = () => {
      if (closed) return;
      attempts += 1;
      onStatus?.("retrying");
      // Render's free tier sleeps; a cold start can take close to a minute,
      // so back off but keep trying rather than giving up.
      setTimeout(open, Math.min(1500 * attempts, 8000));
    };

    ws.onerror = () => onStatus?.("retrying");
  }

  open();
  return handle;
}

/**
 * Joins the Vonage session. localEl / remoteEl are container DOM nodes.
 */
export async function startCall(_ws, { localEl, remoteEl, onStatus }) {
  const OT = window.OT;
  if (!OT) {
    onStatus?.("error");
    throw new Error("Vonage SDK not loaded");
  }

  const appId = import.meta.env.VITE_VONAGE_KEY;
  const sessionId = import.meta.env.VITE_VONAGE_SESSION;
  const token = import.meta.env.VITE_VONAGE_TOKEN;

  if (!appId || !sessionId || !token) {
    onStatus?.("error");
    throw new Error("Missing Vonage credentials");
  }

  onStatus?.("connecting");

  const session = OT.initSession(appId, sessionId);
  let subscriber = null;

  session.on("streamCreated", (event) => {
    subscriber = session.subscribe(
      event.stream, remoteEl,
      { insertMode: "append", width: "100%", height: "100%", showControls: false },
      (err) => onStatus?.(err ? "error" : "live")
    );
  });

  session.on("streamDestroyed", () => { subscriber = null; onStatus?.("waiting"); });
  session.on("sessionDisconnected", () => onStatus?.("waiting"));

  await new Promise((resolve, reject) => {
    session.connect(token, (err) => (err ? reject(err) : resolve()));
  });

  const publisher = OT.initPublisher(
    localEl,
    {
      insertMode: "append", width: "100%", height: "100%",
      showControls: false, publishAudio: true, publishVideo: true, mirror: true,
    },
    (err) => onStatus?.(err ? "nocam" : (subscriber ? "live" : "waiting"))
  );

  session.publish(publisher);

  return {
    handle() {},
    stop() {
      try {
        session.unpublish(publisher);
        publisher.destroy();
        session.disconnect();
      } catch { /* already gone */ }
    },
  };
}
