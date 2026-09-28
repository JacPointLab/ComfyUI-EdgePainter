"""ComfyUI-EdgePainter: draw guide strokes over an image (Edge Painter) or retouch a guide in black and white
(Edge Pencil), with the built-in MaskEditor."""
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
