"""
Backend for Committee Couture.

Rooms hold their own look, subject photo and clients. The websocket also
relays WebRTC signalling between peers in the same room, so the video call
runs peer to peer with no third party service involved.
"""

import asyncio
import base64
import json
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware

from look_state import LookState
import gemini_client

load_dotenv()

MOCK = os.getenv("MOCK", "1") == "1"
LIVE = os.getenv("LIVE", "0") == "1"
SAMPLE_PHOTO = Path(os.getenv("BASE_PHOTO", "base.jpg"))
UPLOADS = Path("uploads")
UPLOADS.mkdir(exist_ok=True)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class Room:
    def __init__(self, code: str):
        self.code = code
        self.photo: Path | None = None
        self.state = LookState(base_photo="")
        self.clients: set[WebSocket] = set()
        self.images: list[str] = []
        self.history: list[dict] = []
        self.lock = asyncio.Lock()

    def set_photo(self, path: Path) -> None:
        self.photo = path
        self.state = LookState(base_photo=str(path))
        self.images = []
        self.history = []

    async def broadcast(self, message: dict, skip: WebSocket | None = None) -> None:
        dead = []
        for ws in list(self.clients):
            if ws is skip:
                continue
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def push(self, pending: str = "") -> None:
        payload = self.state.payload(images=self.images, pending=pending)
        payload["history"] = self.history[-40:]
        payload["room"] = self.code
        payload["people"] = len(self.clients)
        payload["hasPhoto"] = self.photo is not None
        if self.photo and not self.images:
            payload["images"] = [_data_url(self.photo)]
        await self.broadcast(payload)

    def log(self, speaker: str, text: str) -> None:
        self.history.append({"speaker": speaker, "text": text})


def _data_url(path: Path) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode()


rooms: dict[str, Room] = {}


def get_room(code: str) -> Room:
    code = code.strip().upper() or "STUDIO"
    if code not in rooms:
        rooms[code] = Room(code)
    return rooms[code]


# ---------------------------------------------------------------------
# Subject photo
# ---------------------------------------------------------------------

@app.post("/photo/{code}")
async def set_photo(code: str, request: Request) -> dict:
    room = get_room(code)
    body = await request.json()

    if body.get("sample"):
        room.set_photo(SAMPLE_PHOTO)
    else:
        raw = body.get("image", "")
        if "," in raw:
            raw = raw.split(",", 1)[1]
        path = UPLOADS / f"{room.code}.jpg"
        path.write_bytes(base64.b64decode(raw))
        room.set_photo(path)

    await room.push()
    return {"ok": True}


# ---------------------------------------------------------------------
# Tool dispatch
# ---------------------------------------------------------------------

async def dispatch_tool_call(room: Room, name: str, args: dict) -> None:
    if room.photo is None:
        return

    state = room.state

    if name == "update_look":
        action = args.get("action", "add")
        item = args.get("item", "")
        attributes = args.get("attributes", "")
        who = args.get("proposed_by", "someone")

        if action == "remove":
            state.remove(item)
        elif action == "modify":
            state.modify(item, attributes, who)
        else:
            state.add(item, attributes, who)

        await room.push(pending=f"{item} {attributes}".strip())

    elif name == "flag_disagreement":
        state.set_contested(
            args.get("option_a", ""), args.get("option_b", ""),
            args.get("wants_a", ""), args.get("wants_b", ""),
        )
        await room.push()

    elif name == "commit":
        await do_render(room)


async def do_render(room: Room) -> None:
    if room.lock.locked() or room.photo is None:
        return

    async with room.lock:
        room.state.clear_dirty()
        room.state.bump()
        await room.broadcast({"type": "rendering"})

        photo = room.photo
        prompts = room.state.contested_prompts()
        if prompts:
            images = await asyncio.gather(
                gemini_client.render(prompts[0], photo, mock=MOCK),
                gemini_client.render(prompts[1], photo, mock=MOCK),
            )
        else:
            images = [await gemini_client.render(room.state.compose(), photo, mock=MOCK)]

        room.images = list(images)
        await room.push()


async def settle_watcher() -> None:
    while True:
        await asyncio.sleep(0.3)
        for room in list(rooms.values()):
            if room.state.settled():
                await do_render(room)


@app.on_event("startup")
async def startup() -> None:
    asyncio.create_task(settle_watcher())


# ---------------------------------------------------------------------
# Mock understanding. Deleted once speech works.
# ---------------------------------------------------------------------

GARMENTS = [
    "french coat", "trench coat", "coat", "jacket", "blazer", "cardigan",
    "sweater", "shirt", "blouse", "dress", "suit", "waistcoat", "vest",
    "beret", "hat", "cap", "scarf", "tie", "bow tie", "gloves", "glasses",
    "sunglasses", "necklace", "earrings", "brooch",
]


def mock_understand(text: str, speaker: str) -> list[tuple[str, dict]]:
    lower = text.lower().strip()

    if lower in ("show me", "show it", "let's see it", "commit", "render"):
        return [("commit", {})]

    if lower.startswith("remove ") or lower.startswith("lose the "):
        item = lower.replace("remove ", "").replace("lose the ", "").strip()
        return [("update_look", {"action": "remove", "item": item, "proposed_by": speaker})]

    item = next((g for g in sorted(GARMENTS, key=len, reverse=True) if g in lower), None)
    if not item:
        return []

    attributes = lower.replace(item, " ").strip(" ,.")
    for filler in ("put him in a", "put her in a", "put them in a", "give him a",
                   "give her a", "add a", "add an", "add", "with a", "wearing a",
                   "maybe a", "maybe", "a ", "an "):
        if attributes.startswith(filler):
            attributes = attributes[len(filler):].strip()

    return [("update_look", {
        "action": "add", "item": item,
        "attributes": attributes, "proposed_by": speaker,
    })]


# ---------------------------------------------------------------------
# Websocket: state, plus WebRTC signalling relay
# ---------------------------------------------------------------------

@app.websocket("/ws/{code}")
async def ws_endpoint(ws: WebSocket, code: str) -> None:
    await ws.accept()
    room = get_room(code)

    # Tell whoever is already here that someone new arrived. They will make
    # the offer, so the newcomer just waits.
    if room.clients:
        await room.broadcast({"type": "peer-joined"})

    room.clients.add(ws)
    await room.push()

    live = None
    if not MOCK and LIVE:
        try:
            live = await gemini_client.start_live_session(
                on_tool_call=lambda n, a: dispatch_tool_call(room, n, a),
                on_speech=lambda text: asyncio.create_task(
                    room.broadcast({"type": "ack", "text": text})
                ),
            )
        except Exception as exc:
            print(f"live session unavailable: {exc}")

    try:
        while True:
            msg = json.loads(await ws.receive_text())
            kind = msg.get("type")

            if kind == "signal":
                # Straight relay to the other peers in this room.
                await room.broadcast(msg, skip=ws)

            elif kind == "audio" and live:
                await live.send_audio(base64.b64decode(msg["pcm"]))

            elif kind == "say":
                text = msg.get("text", "")
                speaker = msg.get("speaker", "someone")
                room.log(speaker, text)
                calls = mock_understand(text, speaker)
                if not calls:
                    await room.push()
                for name, args in calls:
                    await dispatch_tool_call(room, name, args)

            elif kind == "resolve":
                room.state.resolve(
                    msg.get("item", "hat"), msg.get("chosen", ""),
                    msg.get("by", "the group"),
                )
                await do_render(room)

    except WebSocketDisconnect:
        pass
    finally:
        room.clients.discard(ws)
        await room.broadcast({"type": "peer-left"})
        if live:
            await live.close()


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True, "mock": MOCK, "live": LIVE,
        "rooms": {c: len(r.clients) for c, r in rooms.items()},
    }
