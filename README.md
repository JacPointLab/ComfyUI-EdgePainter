# Edge Painter for ComfyUI

**Draw guide strokes over an image with the built-in MaskEditor, and get the strokes out as a clean layer.**

Edge Painter is a *Load Image* node with extra outputs. Right click it, choose **Open in MaskEditor**, and paint. Whatever you paint comes out separately as **white lines on black**, ready for Canny, Lineart or Scribble ControlNets. It also works as a mask or an overlay.

It changes nothing else: your normal *Load Image* and MaskEditor keep working exactly as before.

## Why
- The MaskEditor is already a good brush tool, but it is set up for masks: a big soft brush, a dark overlay, and the result mixed into the image's alpha.
- For guide lines you want a thin, hard, white brush and the strokes as their own image. Edge Painter gives you exactly that, with no new canvas to learn.

## Features
- **Stroke profile, only for this node.** When the MaskEditor is opened from an Edge Painter node, it switches to:
  - a white mask at full opacity;
  - a thin hard brush (3 px, opacity 1, step 2).
- **Your settings are left alone.** When you close the editor, your usual MaskEditor settings are restored. Brush changes you make inside Edge Painter are remembered separately for next time.
- **White strokes in the node preview**, instead of dark transparency.
- **Optional `mask` input: the area you paint in.** Connect your inpaint mask:
  - strokes outside it are discarded from every output;
  - if the mask comes from a painted *Load Image*, everything outside the area is dimmed (translucent, so you still see the photo) **both in the node preview and inside the MaskEditor**. The shading follows zoom and pan, and it is display-only: it is never saved into the image.
  - An empty mask is ignored.
- **Built-in guide fusion.** Connect the original guide (for example the Canny or Lineart of the same image) to the optional `guide` input, and choose `fusion`:
  - `replace`: inside the area, only your strokes. Use it to **change a shape**, such as a skirt, an arm or a road.
  - `add`: inside the area, the original guide **plus** your strokes. Use it to **add details** while keeping the shape: embroidery, prints, seams, patterns.

  The guide is resized to the image automatically, because preprocessors return their own resolution.
- **Five outputs:**

  | Output | Content |
  |---|---|
  | `image` | the loaded image, untouched |
  | `strokes` | only your strokes, white on black |
  | `strokes_mask` | your strokes as a MASK |
  | `overlay` | the image with your strokes burned in white |
  | `fused_guide` | the guide outside the area, and inside it `replace` or `add` (equals `strokes` without a `guide` input) |

- No dependencies, and nothing is patched globally. The node is plain Python, plus a small frontend script that only acts on Edge Painter nodes.

## Edge Pencil: retouch a guide in black and white
The quickest fix for a guide: take the Canny (or Lineart, HED, depth...) of your photo **at its original size**, and touch it up by hand.

1. Connect the preprocessor output to `guide`, and the photo to `size_like` (preprocessors return their own resolution; this puts the guide back to the exact size of the photo).
2. **Run once.** The node shows the guide.
3. Right click, **Open in MaskEditor**. It opens on the paint brush, white and thin:
   - **white adds lines**;
   - press **X** to switch to **black and erase lines** (X again goes back to white);
   - white and black keep **their own brush size** (black starts at 12 px, to cover quickly).
4. Save, and run again: the `guide` output is your retouched guide. `edited_mask` marks where you painted.

If the incoming guide changes (a new photo, new thresholds), the node starts over from the new guide. The **restart from guide** button drops your retouches on purpose. As with Edge Painter, your normal MaskEditor settings are restored when you close the editor.

`example_workflows/edge_pencil_basic.json`: Load Image → Canny → Edge Pencil → preview.

## Typical uses
- **Guided inpainting:** draw the edges of a road, a river or a wall with Edge Painter. Merge them with the Canny of the original photo inside your inpaint mask, then feed the result to a Canny ControlNet. The new content follows your lines and blends with the rest of the photo.
- **Scribble / Lineart ControlNet** straight from a sketch over a reference photo.
- **Quick masks** made of thin lines, such as cracks, wires or hair strands.

## Install
- **ComfyUI-Manager:** search for "Edge Painter", once it is published.
- **Manually:**
  ```
  cd ComfyUI/custom_nodes
  git clone https://github.com/JacPointLab/ComfyUI-EdgePainter
  ```
  Then restart ComfyUI.

Requirements: a ComfyUI frontend that has the Vue MaskEditor (2025 or later). On older frontends the node still works as a Load Image with stroke outputs, but the automatic stroke profile is skipped.

## Example
- `example_workflows/edge_painter_basic.json` loads an image, and previews the strokes and the overlay.
- `example_workflows/edge_pencil_basic.json` retouches a Canny in black and white.

## License
MIT

---

## Español
Es un *Load Image* con salidas extra. Clic derecho → **Open in MaskEditor** y dibuja: lo pintado sale aparte, **en blanco sobre negro**, listo para ControlNet Canny, Lineart o Scribble. También sale como máscara (`strokes_mask`) y sobre la imagen (`overlay`).

Entrada opcional **`mask`**: la zona donde se pinta (tu máscara de inpaint). Los trazos fuera de ella se descartan, y lo que queda fuera se oscurece, de forma translúcida, **en la vista del nodo y dentro del MaskEditor**. Es solo visual y no se guarda.

Entrada opcional **`guide`** (la guía original, por ejemplo el Canny de la foto) y selector **`fusion`**:
- `replace`: dentro de la zona solo tus trazos, para cambiar una forma.
- `add`: dentro de la zona, la guía original más tus trazos, para agregar detalles como bordados o estampados.

La salida `fused_guide` va directo al ControlNet.

Solo al abrir el editor **desde Edge Painter** se activa el perfil de trazos: pincel fino y duro, y máscara blanca opaca. Al cerrarlo, tu MaskEditor normal vuelve a tus ajustes, y el pincel de Edge Painter se recuerda por separado.

### Edge Pencil (retocar una guía en blanco y negro)
Conecta el Canny (u otra guía) a `guide` y la foto a `size_like`, para que la guía quede al tamaño exacto de la foto. Run una vez, clic derecho → **Open in MaskEditor**:
- **blanco** agrega líneas;
- **X** cambia a **negro** para borrar líneas;
- cada color recuerda su grosor.

Guarda y vuelve a ejecutar: la salida `guide` es tu guía retocada. Si cambia la guía de entrada, el nodo empieza de nuevo; el botón *restart from guide* descarta los retoques.
