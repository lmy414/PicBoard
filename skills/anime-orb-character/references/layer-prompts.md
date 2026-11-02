# Layer prompt pattern

Use one image request per layer. A multi-cell sheet can be useful for ideation, but its parts often merge or drift and should not be treated as runtime-ready. Keep the original image as the identity source and a finished face/base layer as a placement reference. For all layers, state the exact canvas size, anchor alignment, transparent pixels, and what must be absent.

## Shared prefix

```text
Use the supplied character image as the identity source and the supplied base layer as the alignment reference. Create only one isolated animation layer on a transparent PNG canvas of <W>x<H>. Preserve the character's face design, colors, line style, and proportions. Center it on the same head anchor as the base layer. Keep all non-layer pixels fully transparent. No sprite sheet, panel, border, label, watermark, background, or extra objects. Do not crop the layer.
```

## Layer-specific requests

- **Head base:** one rounded face/head silhouette with cheeks and ears as appropriate; remove hair, eyes, brows, and mouth. Reconstruct only skin hidden under removed artwork.
- **Back hair:** a complete hair mass intended behind the face, with a transparent opening that reveals the face. Keep hair outside the face region, not a detached halo or top-only strand.
- **Front fringe:** only bangs and optional short face-framing locks. Explicitly keep the eye and mouth regions transparent; specify where the hair tips stop relative to the eye line.
- **Eyes:** request one state only (open, blink, happy closed, surprised). Keep left and right eyes at the same eye-line anchors as the face reference.
- **Mouth:** request one state only (neutral, smile, open intake, error). Put it on the face centerline at a fixed mouth anchor.
- **Accessories:** one detachable layer with an explicit pivot; do not bake it into the face or hair.

For each output, compare the alpha silhouette and anchor placement with the base at native size and at the actual floating-window size. Regenerate a single bad layer rather than changing the entire character at once.
