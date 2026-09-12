"""
Look state for the group styling call.

The whole integrity of the demo rests on one property: the base photo is never
replaced by a generated image. Every render goes from the original plus the
accumulated text layers, so generation depth is always 1 and the subject's face
never drifts, no matter how many suggestions the group makes.

No SDK calls in here on purpose. This logic does not care which model you use
and will not break when an API signature changes on you.
"""

from dataclasses import dataclass, field, asdict
from typing import Optional
import time

MAX_LAYERS = 8
SETTLE_SECONDS = 1.5


@dataclass
class Layer:
    id: int
    item: str
    attributes: str
    proposed_by: str


@dataclass
class Contested:
    option_a: str
    option_b: str
    wants_a: str
    wants_b: str


@dataclass
class LookState:
    base_photo: str
    layers: list[Layer] = field(default_factory=list)
    contested: Optional[Contested] = None
    version: int = 0
    _next_id: int = 1
    _last_touched: float = field(default_factory=time.monotonic)
    _dirty: bool = False

    # ---- mutations -------------------------------------------------

    def add(self, item: str, attributes: str, proposed_by: str) -> Layer:
        if self._find(item):
            return self.modify(item, attributes, proposed_by)

        if len(self.layers) >= MAX_LAYERS:
            self.layers.pop(0)

        layer = Layer(self._next_id, item, attributes, proposed_by)
        self.layers.append(layer)
        self._next_id += 1
        self._touch()
        return layer

    def modify(self, item: str, attributes: str, proposed_by: str) -> Layer:
        layer = self._find(item)
        if not layer:
            return self.add(item, attributes, proposed_by)
        if attributes:
            layer.attributes = f"{layer.attributes}, {attributes}"
        layer.proposed_by = proposed_by
        self._touch()
        return layer

    def remove(self, item: str) -> bool:
        layer = self._find(item)
        if not layer:
            return False
        self.layers.remove(layer)
        self._touch()
        return True

    def set_contested(self, option_a, option_b, wants_a, wants_b) -> None:
        self.contested = Contested(option_a, option_b, wants_a, wants_b)
        self._touch()

    def resolve(self, item: str, chosen: str, proposed_by: str) -> None:
        self.contested = None
        self.add(item, chosen, proposed_by)

    # ---- render gating ---------------------------------------------

    def settled(self) -> bool:
        """True once the room has stopped adding for a moment."""
        return self._dirty and (time.monotonic() - self._last_touched) >= SETTLE_SECONDS

    def clear_dirty(self) -> None:
        self._dirty = False

    def bump(self) -> int:
        self.version += 1
        return self.version

    # ---- prompt composition ----------------------------------------

    def compose(self, override: Optional[str] = None) -> str:
        """
        Build the single instruction sent alongside the ORIGINAL photo.

        `override` substitutes one contested option so you can render A and B
        side by side without mutating state.
        """
        lines = [
            "Edit the person in this photograph so they are wearing the outfit "
            "described below. Keep their face, hair, body, pose and the "
            "background exactly as they are in the original. Change only the "
            "clothing.",
            "",
            "Outfit:",
        ]

        for layer in self.layers:
            lines.append(f"- {layer.item}: {layer.attributes}")

        if override:
            lines.append(f"- {override}")

        if not self.layers and not override:
            lines.append("- unchanged from the original")

        lines += [
            "",
            # This paragraph was tested against the real model. Without the
            # framing sentence the render zooms in and changes aspect ratio
            # between versions, which reads as instability even when the
            # clothing is right.
            "Preserve the exact framing, crop and aspect ratio of the original "
            "photograph. Do not zoom in, do not recompose, do not change how "
            "much of the person is visible.",
            "",
            "Anything not described above stays as it appears in the original "
            "photograph. Do not add accessories, change the lighting, or alter "
            "the setting. Photographic, natural light, realistic fabric.",
        ]
        return "\n".join(lines)

    def contested_prompts(self) -> Optional[tuple[str, str]]:
        if not self.contested:
            return None
        return (
            self.compose(override=self.contested.option_a),
            self.compose(override=self.contested.option_b),
        )

    # ---- wire format for the clients -------------------------------

    def payload(self, images: Optional[list[str]] = None, pending: str = "") -> dict:
        return {
            "type": "state",
            "version": self.version,
            "layers": [asdict(l) for l in self.layers],
            "contested": asdict(self.contested) if self.contested else None,
            "images": images or [],
            "pending": pending,
        }

    # ---- internals -------------------------------------------------

    def _find(self, item: str) -> Optional[Layer]:
        needle = item.strip().lower()
        for layer in self.layers:
            if layer.item.strip().lower() == needle:
                return layer
        return None

    def _touch(self) -> None:
        self._last_touched = time.monotonic()
        self._dirty = True


# ---------------------------------------------------------------------
# Tool declarations for the Live session.
# Three tools. Resist adding a fourth before the demo works end to end.
# ---------------------------------------------------------------------

TOOLS = [
    {
        "name": "update_look",
        "description": (
            "Record a clothing change that someone on the call proposed out "
            "loud. Use only attributes that were actually spoken."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["add", "modify", "remove"]},
                "item": {
                    "type": "string",
                    "description": "The garment, e.g. coat, beret, shoes.",
                },
                "attributes": {
                    "type": "string",
                    "description": (
                        "Only what was said. 'green, black buttons, grey "
                        "piping'. Empty for remove."
                    ),
                },
                "proposed_by": {
                    "type": "string",
                    "description": "Name of the person who suggested it.",
                },
            },
            "required": ["action", "item", "proposed_by"],
        },
    },
    {
        "name": "flag_disagreement",
        "description": (
            "Two people want incompatible things. Record both. Never pick one."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "option_a": {"type": "string"},
                "option_b": {"type": "string"},
                "wants_a": {"type": "string"},
                "wants_b": {"type": "string"},
            },
            "required": ["option_a", "option_b", "wants_a", "wants_b"],
        },
    },
    {
        "name": "commit",
        "description": (
            "The group has finished a burst of suggestions and wants to see "
            "the result. Triggers a render."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
]
