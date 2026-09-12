import { useEffect, useRef, useState } from "react";
import { connectBackend, startCall } from "./call";
import "./styles.css";

const HTTP = (import.meta.env.VITE_API || "ws://localhost:8000/ws")
  .replace(/^ws/, "http")
  .replace(/\/ws$/, "");

function randomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 4; i++) out += letters[Math.floor(Math.random() * letters.length)];
  return out;
}

export default function App() {
  const [session, setSession] = useState(null);
  return session ? <Studio {...session} /> : <Entry onEnter={setSession} />;
}

/* ------------------------------------------------------------------ */

function Entry({ onEnter }) {
  const params = new URLSearchParams(location.search);
  const [name, setName] = useState(params.get("name") || "");
  const [code, setCode] = useState((params.get("room") || "").toUpperCase());
  const [error, setError] = useState("");

  function enter(e) {
    e.preventDefault();
    if (!name.trim()) return setError("We need a name to credit your ideas to.");
    if (!code.trim()) return setError("Enter a room code, or start a new room.");
    onEnter({ name: name.trim(), code: code.trim().toUpperCase() });
  }

  function startNew() {
    if (!name.trim()) return setError("We need a name to credit your ideas to.");
    onEnter({ name: name.trim(), code: randomCode() });
  }

  return (
    <div className="entry">
      <div className="entry-inner">
        <p className="wordmark">Committee Couture</p>
        <h1>Couture is one designer<br />and one client.</h1>
        <p className="lede">
          We made it a room full of your friends. Bring them in, argue about
          the buttons, and watch the look change while you talk.
        </p>

        <form onSubmit={enter} className="entry-form">
          <label>
            Your name
            <input value={name} autoFocus placeholder="Ruth"
              onChange={(e) => { setName(e.target.value); setError(""); }} />
          </label>
          <label>
            Room code
            <input value={code} placeholder="ABCD" maxLength={8}
              onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(""); }} />
          </label>
          <div className="entry-actions">
            <button type="submit" className="primary">Join the room</button>
            <button type="button" onClick={startNew}>Start a new room</button>
          </div>
        </form>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SubjectPicker({ code, onDone }) {
  const [mode, setMode] = useState("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const videoEl = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => () => stopCamera(), []);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function send(body) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${HTTP}/photo/${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(res.statusText);
      stopCamera();
      onDone();
    } catch {
      setError("That didn't upload. Try again, or use the sample photo.");
      setBusy(false);
    }
  }

  async function openCamera() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 1280, facingMode: "user" },
      });
      streamRef.current = stream;
      setMode("camera");
      requestAnimationFrame(() => {
        if (videoEl.current) {
          videoEl.current.srcObject = stream;
          videoEl.current.play();
        }
      });
    } catch {
      setError("No camera access. Upload a photo instead.");
    }
  }

  function capture() {
    const video = videoEl.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 1125;
    const ctx = canvas.getContext("2d");
    const cropW = Math.min(video.videoWidth, video.videoHeight * 0.8);
    const cropH = cropW * 1.25;
    ctx.drawImage(
      video,
      (video.videoWidth - cropW) / 2, (video.videoHeight - cropH) / 2,
      cropW, cropH, 0, 0, canvas.width, canvas.height
    );
    send({ image: canvas.toDataURL("image/jpeg", 0.9) });
  }

  function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => send({ image: reader.result });
    reader.onerror = () => setError("Couldn't read that file.");
    reader.readAsDataURL(file);
  }

  return (
    <div className="subject">
      <h2>Who are we dressing?</h2>

      {mode === "camera" ? (
        <>
          <video ref={videoEl} className="cam" muted playsInline />
          <div className="subject-actions">
            <button className="primary" onClick={capture} disabled={busy}>
              {busy ? "Uploading" : "Take the photo"}
            </button>
            <button onClick={() => { stopCamera(); setMode("choose"); }}>Back</button>
          </div>
          <p className="hint">Head and shoulders, plain wall if you can find one.</p>
        </>
      ) : (
        <>
          <p className="hint">A head-and-shoulders shot works best. Even light, plain background.</p>
          <div className="subject-actions">
            <button className="primary" onClick={openCamera} disabled={busy}>Use the camera</button>
            <label className="filebtn">
              Upload a photo
              <input type="file" accept="image/*" onChange={onFile} disabled={busy} />
            </label>
            <button onClick={() => send({ sample: true })} disabled={busy}>Use the sample</button>
          </div>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

const STATUS = {
  waiting: "waiting for the committee",
  connecting: "connecting",
  live: "live",
  nocam: "no camera",
  alone: "just you",
};

function Studio({ name, code }) {
  const [look, setLook] = useState({
    layers: [], images: [], contested: null, history: [], people: 1, hasPhoto: false,
  });
  const [rendering, setRendering] = useState(false);
  const [ack, setAck] = useState("");
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [changing, setChanging] = useState(false);
  const [callStatus, setCallStatus] = useState("waiting");

  const ws = useRef(null);
  const callRef = useRef(null);
  const localEl = useRef(null);
  const remoteEl = useRef(null);
  const feedEl = useRef(null);

  useEffect(() => {
    ws.current = connectBackend(code, (msg) => {
      callRef.current?.handle(msg);

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

    startCall(ws.current, {
      onLocal: (stream) => {
        if (localEl.current) localEl.current.srcObject = stream;
      },
      onRemote: (stream) => {
        if (remoteEl.current) remoteEl.current.srcObject = stream;
      },
      onStatus: setCallStatus,
    })
      .then((call) => { callRef.current = call; })
      .catch(() => setCallStatus("nocam"));

    return () => callRef.current?.stop();
  }, []);

  useEffect(() => {
    if (feedEl.current) feedEl.current.scrollTop = feedEl.current.scrollHeight;
  }, [look.history]);

  function say(e) {
    e.preventDefault();
    if (!draft.trim()) return;
    ws.current.send(JSON.stringify({ type: "say", text: draft, speaker: name }));
    setDraft("");
  }

  function resolve(chosen) {
    ws.current.send(JSON.stringify({ type: "resolve", item: "hat", chosen, by: "the group" }));
  }

  function copyCode() {
    navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  const needsPhoto = !look.hasPhoto || changing;
  const twoUp = look.images.length > 1;

  return (
    <div className="studio">
      <header className="bar">
        <p className="wordmark small">Committee Couture</p>
        <span className={`dot ${callStatus}`} />
        <span className="who">{STATUS[callStatus]}</span>
        <button className="room" onClick={copyCode}>
          {copied ? "Code copied" : `Room ${code}`}
        </button>
      </header>

      <main className="canvas">
        {needsPhoto ? (
          <SubjectPicker code={code} onDone={() => setChanging(false)} />
        ) : (
          <>
            <div className={twoUp ? "looks split" : "looks"}>
              {look.images.map((src, i) => (
                <figure key={`${look.version}-${i}`}>
                  <img src={src} alt="" />
                  {twoUp && look.contested && (
                    <figcaption>
                      <span>{i === 0 ? look.contested.option_a : look.contested.option_b}</span>
                      <button onClick={() => resolve(
                        i === 0 ? look.contested.option_a : look.contested.option_b
                      )}>Keep this</button>
                    </figcaption>
                  )}
                </figure>
              ))}
              {rendering && <p className="working">Working on it</p>}
            </div>
            {ack && <p className="ack">{ack}</p>}
          </>
        )}
      </main>

      <aside className="rail">
        <section className="video">
          <div className="tile">
            <video ref={localEl} muted playsInline autoPlay />
            <span className="label">{name}</span>
          </div>
          <div className="tile">
            <video ref={remoteEl} playsInline autoPlay />
            <span className="label">
              {callStatus === "live" ? "the committee" : "empty chair"}
            </span>
          </div>
        </section>

        <section className="pane">
          <h2>The look</h2>
          {look.layers.length === 0 ? (
            <p className="muted">Nothing yet. Name a garment below.</p>
          ) : (
            <ul className="layers">
              {look.layers.map((l) => (
                <li key={l.id}>
                  <span className="item">{l.item}</span>
                  {l.attributes && <span className="attrs">{l.attributes}</span>}
                  <span className="by">{l.proposed_by}</span>
                </li>
              ))}
            </ul>
          )}
          {look.contested && (
            <p className="split-note">
              {look.contested.wants_a} wants {look.contested.option_a}.{" "}
              {look.contested.wants_b} wants {look.contested.option_b}.
            </p>
          )}
          {look.hasPhoto && !changing && (
            <button className="ghost" onClick={() => setChanging(true)}>
              Change the subject
            </button>
          )}
        </section>

        <section className="pane feed-pane">
          <h2>The conversation</h2>
          <div className="feed" ref={feedEl}>
            {(look.history || []).length === 0 ? (
              <p className="muted">Quiet so far.</p>
            ) : (
              look.history.map((h, i) => (
                <p key={i} className="line">
                  <span className="speaker">{h.speaker}</span>{h.text}
                </p>
              ))
            )}
          </div>
        </section>

        <form onSubmit={say} className="composer">
          <input value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="a beige beret tilted to the left" />
          <button type="submit">Say it</button>
        </form>
      </aside>
    </div>
  );
}
