import { useEffect, useRef, useState } from "react";
import { connectBackend, createMixer, joinRoom } from "./call";
import "./styles.css";

const params = new URLSearchParams(location.search);
const ROLE = params.get("role") || "guest";
const NAME = params.get("name") || (ROLE === "host" ? "Host" : "Guest");
const MOCK = import.meta.env.VITE_MOCK !== "0";

export default function App() {
  const [look, setLook] = useState({ layers: [], images: [], contested: null });
  const [ack, setAck] = useState("");
  const [rendering, setRendering] = useState(false);
  const [draft, setDraft] = useState("");

  const ws = useRef(null);
  const publisherEl = useRef(null);
  const subscriberEl = useRef(null);

  useEffect(() => {
    ws.current = connectBackend((msg) => {
      if (msg.type === "state") {
        setLook(msg);
        setRendering(false);
        if (msg.pending) setAck(msg.pending);
      } else if (msg.type === "rendering") {
        setRendering(true);
      } else if (msg.type === "ack") {
        setAck(msg.text);
      }
    });

    if (!MOCK && ROLE === "host") {
      const mixer = createMixer(ws.current);
      joinRoom({
        apiKey: import.meta.env.VITE_VONAGE_KEY,
        sessionId: import.meta.env.VITE_VONAGE_SESSION,
        token: import.meta.env.VITE_VONAGE_TOKEN,
        onStream: mixer.addStream,
        publisherEl: publisherEl.current,
        subscriberEl: subscriberEl.current,
      }).then(mixer.resume).catch(console.error);
    }
  }, []);

  function say(e) {
    e.preventDefault();
    if (!draft.trim()) return;
    ws.current.send(JSON.stringify({ type: "say", text: draft, speaker: NAME }));
    setDraft("");
  }

  function resolve(chosen) {
    ws.current.send(JSON.stringify({
      type: "resolve", item: "hat", chosen, by: "the group",
    }));
  }

  const twoUp = look.images.length > 1;

  return (
    <div className="room">
      <main className="stage">
        {rendering && <p className="working">Working on it</p>}

        <div className={twoUp ? "looks looks-split" : "looks"}>
          {look.images.length === 0 && (
            <p className="empty">Say what they should wear.</p>
          )}
          {look.images.map((src, i) => (
            <figure key={i} className="look">
              <img src={src} alt="" />
              {twoUp && look.contested && (
                <figcaption>
                  <span>{i === 0 ? look.contested.option_a : look.contested.option_b}</span>
                  <button onClick={() => resolve(
                    i === 0 ? look.contested.option_a : look.contested.option_b
                  )}>
                    Keep this
                  </button>
                </figcaption>
              )}
            </figure>
          ))}
        </div>

        {ack && <p className="heard">{ack}</p>}
      </main>

      <aside className="panel">
        <h1>The look</h1>

        {look.layers.length === 0 ? (
          <p className="empty-small">Nothing yet.</p>
        ) : (
          <ol className="layers">
            {look.layers.map((l) => (
              <li key={l.id}>
                <span className="item">{l.item}</span>
                <span className="attrs">{l.attributes}</span>
                <span className="by">{l.proposed_by}</span>
              </li>
            ))}
          </ol>
        )}

        {look.contested && (
          <p className="split">
            {look.contested.wants_a} wants {look.contested.option_a}.{" "}
            {look.contested.wants_b} wants {look.contested.option_b}.
          </p>
        )}

        {!MOCK && (
          <div className="video">
            <div ref={publisherEl} className="tile" />
            <div ref={subscriberEl} className="tiles" />
          </div>
        )}

        {MOCK && (
          <form onSubmit={say} className="composer">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="a green french coat with black buttons"
            />
            <button type="submit">Say it</button>
          </form>
        )}
      </aside>
    </div>
  );
}
