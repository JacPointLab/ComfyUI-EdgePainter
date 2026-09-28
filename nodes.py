"""Edge Painter: a Load Image you can draw guide strokes on with the built-in MaskEditor.

Whatever you paint with the MaskEditor becomes the strokes layer, returned separately:
  image        -> the image, untouched
  strokes      -> only your strokes, white on black (ready for Canny / Lineart / Scribble ControlNets)
  strokes_mask -> your strokes as a MASK (1 = painted)
  overlay      -> the image with your strokes burned in white (handy for previews or scribble-over-photo)
  fused_guide  -> with the optional `guide` input: the guide outside the area, and inside it your strokes ('replace')
                  or guide + strokes ('add')
Optional `mask` input: the area you are allowed to paint in (e.g. the inpaint mask). Strokes outside it are dropped.
"""
import hashlib
import os

import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence

import folder_paths
import node_helpers


class EdgePainter:
    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["image"])
        return {
            "required": {"image": (sorted(files), {"image_upload": True})},
            "optional": {
                "mask": ("MASK", {"tooltip": "Optional area to paint in (e.g. your inpaint mask). Strokes outside it are "
                                             "discarded, and the rest is dimmed in the preview and in the MaskEditor."}),
                "guide": ("IMAGE", {"tooltip": "Optional original guide (e.g. Canny/Lineart of this image). "
                                               "Enables the fused_guide output."}),
                "fusion": (["replace", "add"], {"default": "replace",
                                                "tooltip": "Inside the area: 'replace' = only your strokes (change a "
                                                           "shape); 'add' = original guide + your strokes (add details "
                                                           "such as embroidery, prints, seams)."}),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK", "IMAGE", "IMAGE")
    RETURN_NAMES = ("image", "strokes", "strokes_mask", "overlay", "fused_guide")
    OUTPUT_TOOLTIPS = (
        "The loaded image, untouched.",
        "Only your strokes: white on black. Plug it into a Canny/Lineart/Scribble ControlNet.",
        "Your strokes as a mask (1 = painted).",
        "The image with your strokes painted in white.",
        "Original guide outside the area; inside it, your strokes ('replace') or guide + strokes ('add'). "
        "Without a guide input it equals 'strokes'.",
    )
    FUNCTION = "load"
    CATEGORY = "image"
    DESCRIPTION = ("Load Image + guide strokes. Right click > Open in MaskEditor and paint: a thin white brush is set "
                   "automatically for this node only (your normal MaskEditor settings are restored when you close it). "
                   "The strokes come out separately, white on black.")
    SEARCH_ALIASES = ["edge painter", "draw guide", "canny sketch", "scribble", "paint lines", "strokes"]

    def load(self, image, mask=None, guide=None, fusion="replace"):
        img = node_helpers.pillow(Image.open, folder_paths.get_annotated_filepath(image))
        frame = next(ImageSequence.Iterator(img))
        frame = node_helpers.pillow(ImageOps.exif_transpose, frame)
        if frame.mode == "I":
            frame = frame.point(lambda v: v * (1 / 255))
        rgb = torch.from_numpy(np.array(frame.convert("RGB")).astype(np.float32) / 255.0)[None,]
        h, w = rgb.shape[1], rgb.shape[2]

        if "A" in frame.getbands():
            painted = 1.0 - torch.from_numpy(np.array(frame.getchannel("A")).astype(np.float32) / 255.0)
        elif frame.mode == "P" and "transparency" in frame.info:
            alpha = np.array(frame.convert("RGBA").getchannel("A")).astype(np.float32) / 255.0
            painted = 1.0 - torch.from_numpy(alpha)
        else:
            painted = torch.zeros((h, w), dtype=torch.float32)

        area = None
        if mask is not None and float(mask.max()) > 0:   # keep only the strokes inside the given area
            area = mask[:1].to(torch.float32)
            if area.shape[-2:] != (h, w):
                area = torch.nn.functional.interpolate(area[:, None], size=(h, w), mode="bilinear")[:, 0]
            area = area[0].clamp(0, 1)
            painted = painted * area

        smask = painted[None,]
        strokes = smask[..., None].expand(-1, -1, -1, 3).clone()
        overlay = rgb * (1.0 - smask[..., None]) + smask[..., None]

        if guide is None:
            fused = strokes
        else:
            g = guide[:1].to(torch.float32)
            if g.shape[1:3] != (h, w):             # preprocessors return their own resolution: match the image
                g = torch.nn.functional.interpolate(g.movedim(-1, 1), size=(h, w), mode="area").movedim(1, -1)
            g = g[..., :3]
            inside = g.maximum(strokes) if fusion == "add" else strokes
            a = (area if area is not None else torch.ones((h, w)))[None, ..., None]
            fused = g * (1.0 - a) + inside * a
        return (rgb, strokes, smask, overlay, fused.clamp(0, 1))

    @classmethod
    def IS_CHANGED(cls, image, mask=None, guide=None, fusion="replace"):
        m = hashlib.sha256()
        with open(folder_paths.get_annotated_filepath(image), "rb") as f:
            m.update(f.read())
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(cls, image, mask=None, guide=None, fusion="replace"):
        if not folder_paths.exists_annotated_filepath(image):
            return f"Invalid image file: {image}"
        return True


class EdgePencil:
    """Retouch a guide (Canny, Lineart, depth...) by hand, in white and black, at the size of the original photo.

    Run once: the incoming guide is resized to `size_like` (the photo), saved to input/edge_pencil/ and shown in the
    node. Right click > Open in MaskEditor: the brush paints white, press X to switch to black (erase lines).
    Run again: the retouched guide comes out. If the incoming guide changes (new photo, new thresholds), the node
    starts over from the new guide.
    """
    SUBFOLDER = "edge_pencil"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "guide": ("IMAGE", {"tooltip": "The guide to retouch, e.g. the output of a Canny preprocessor."}),
                "image": ("STRING", {"default": "", "tooltip": "Managed by the node: the guide file you paint on."}),
                "source": ("STRING", {"default": "", "tooltip": "Managed by the node: fingerprint of the guide."}),
            },
            "optional": {
                "size_like": ("IMAGE", {"tooltip": "The original photo: the guide is resized to its exact size "
                                                   "(preprocessors return their own resolution)."}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("guide", "edited_mask")
    OUTPUT_TOOLTIPS = ("The guide with your white and black retouches, at the size of the original photo.",
                       "Where you painted (1 = retouched).")
    FUNCTION = "edit"
    OUTPUT_NODE = True
    CATEGORY = "image"
    DESCRIPTION = ("Hand-retouch a guide at the original size. Run once, then right click > Open in MaskEditor: "
                   "white pencil adds lines, X switches to black to erase them. Run again to use the result.")
    SEARCH_ALIASES = ["edge pencil", "edit canny", "retouch guide", "paint canny", "lineart edit"]

    @staticmethod
    def _prepare(guide, size_like):
        g = guide[:1, ..., :3].to(torch.float32)
        if size_like is not None and g.shape[1:3] != size_like.shape[1:3]:
            g = torch.nn.functional.interpolate(g.movedim(-1, 1), size=tuple(size_like.shape[1:3]),
                                                mode="area").movedim(1, -1)
        return g.clamp(0, 1)

    def edit(self, guide, image="", source="", size_like=None):
        g = self._prepare(guide, size_like)
        arr = (g[0].cpu().numpy() * 255).round().astype(np.uint8)
        fp = hashlib.sha256(arr.tobytes()).hexdigest()[:16]
        path = self._resolve(image)
        if source != fp or not path or not os.path.isfile(path):
            # new guide: save it where the MaskEditor can open it, and point the node to it
            folder = os.path.join(folder_paths.get_input_directory(), self.SUBFOLDER)
            os.makedirs(folder, exist_ok=True)
            name = f"guide_{fp}.png"
            if not os.path.isfile(os.path.join(folder, name)):
                Image.fromarray(arr).save(os.path.join(folder, name), compress_level=4)
            ui = {"images": [{"filename": name, "subfolder": self.SUBFOLDER, "type": "input"}],
                  "edge_pencil": [{"image": f"{self.SUBFOLDER}/{name} [input]", "source": fp}]}
            return {"ui": ui, "result": (g, torch.zeros(g.shape[:3]))}

        # retouched file: paint layer (white/black) is already in the RGB, mask strokes count as white
        frame = node_helpers.pillow(Image.open, path)
        frame = node_helpers.pillow(ImageOps.exif_transpose, frame)
        rgba = np.array(frame.convert("RGBA")).astype(np.float32) / 255.0
        rgb = torch.from_numpy(rgba[..., :3])[None,]
        painted = torch.from_numpy(1.0 - rgba[..., 3])[None,]
        out = rgb * (1.0 - painted[..., None]) + painted[..., None]
        if out.shape[1:3] != g.shape[1:3]:
            out = torch.nn.functional.interpolate(out.movedim(-1, 1), size=tuple(g.shape[1:3]),
                                                  mode="bilinear").movedim(1, -1)
        edited = ((out - g).abs().amax(-1) > 0.02).to(torch.float32)
        rel = os.path.relpath(path, folder_paths.get_input_directory()).replace(os.sep, "/")
        sub, _, name = rel.rpartition("/")
        ui = {"images": [{"filename": name, "subfolder": sub, "type": "input"}]}
        return {"ui": ui, "result": (out.clamp(0, 1), edited)}

    @staticmethod
    def _resolve(image):
        """File the node points to; the MaskEditor may store 'clipspace-...png [input]' without its subfolder."""
        if not image:
            return None
        for cand in (image, "clipspace/" + image):
            try:
                path = folder_paths.get_annotated_filepath(cand)
            except Exception:
                continue
            if os.path.isfile(path):
                return path
        return None

    @classmethod
    def IS_CHANGED(cls, guide, image="", source="", size_like=None):
        m = hashlib.sha256((image + "|" + source).encode())
        path = cls._resolve(image)
        if path:
            with open(path, "rb") as f:
                m.update(f.read())
        return m.hexdigest()


NODE_CLASS_MAPPINGS = {"EdgePainter": EdgePainter, "EdgePencil": EdgePencil}
NODE_DISPLAY_NAME_MAPPINGS = {"EdgePainter": "Edge Painter (Load Image + guide strokes)",
                              "EdgePencil": "Edge Pencil (retouch a guide in black & white)"}
