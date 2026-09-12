// Backend socket plus the Vonage Video call.
//
// Vonage inserts its own video elements into container nodes, so App.jsx
// passes the tile divs rather than <video> refs.

export function connectBackend(code, onMessage) {
  const base = import.meta.env.VITE_API || "ws://localhost:8000/ws";
  const ws = new WebSocket(`${base}/${encodeURIComponent(code)}`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  return ws;
}

/**
 * Joins the Vonage session.
 *
 * localEl / remoteEl  container DOM nodes
 * onStatus(text)      "waiting" | "connecting" | "live" | "nocam" | "error"
 */
export async function startCall(_ws, { localEl, remoteEl, onStatus }) {
  const OT = window.OT;
  if (!OT) {
    onStatus?.("error");
    throw new Error("Vonage SDK not loaded. Check the script tag in index.html.");
  }

  const appId = import.meta.env.VITE_VONAGE_KEY;
  const sessionId = import.meta.env.VITE_VONAGE_SESSION;
  const token = import.meta.env.VITE_VONAGE_TOKEN;

  if (!appId || !sessionId || !token) {
    onStatus?.("error");
    throw new Error("Missing Vonage credentials in web/.env");
  }

  onStatus?.("connecting");

  const session = OT.initSession(appId, sessionId);
  let subscriber = null;

  session.on("streamCreated", (event) => {
    subscriber = session.subscribe(
      event.stream,
      remoteEl,
      { insertMode: "append", width: "100%", height: "100%", showControls: false },
      (err) => onStatus?.(err ? "error" : "live")
    );
  });

  session.on("streamDestroyed", () => {
    subscriber = null;
    onStatus?.("waiting");
  });

  session.on("sessionDisconnected", () => onStatus?.("waiting"));

  await new Promise((resolve, reject) => {
    session.connect(token, (err) => (err ? reject(err) : resolve()));
  });

  const publisher = OT.initPublisher(
    localEl,
    {
      insertMode: "append",
      width: "100%",
      height: "100%",
      showControls: false,
      // Audio published for the call; the design prompts come from the
      // browser's own speech recognition, which uses a separate mic handle.
      publishAudio: true,
      publishVideo: true,
      mirror: true,
    },
    (err) => {
      if (err) {
        onStatus?.("nocam");
      } else {
        onStatus?.(subscriber ? "live" : "waiting");
      }
    }
  );

  session.publish(publisher);

  return {
    // Kept so App.jsx can pass websocket messages in without caring which
    // video backend is running. Vonage handles its own signalling.
    handle() {},
    stop() {
      try {
        session.unpublish(publisher);
        publisher.destroy();
        session.disconnect();
      } catch {
        /* already torn down */
      }
    },
  };
}
