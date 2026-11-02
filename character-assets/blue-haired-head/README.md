# Blue-haired head source cuts

`source-reference.png` is the unchanged original. The interactive demo now rebuilds the character from aligned, transparent pixel masks under `source-layers/`: face, left and right eye, six blue and cool-tone hair regions, and `source-support.png` for every pixel not assigned to those parts. `reassembled-preview.png` is the resulting source-only composite.

The extraction script is `skills/anime-orb-character/scripts/extract_original_parts.py`; its choices and source limitations are recorded in `source-layers.json`. It does not paint replacement features. Hair that is clipped by the source canvas stays clipped; hidden pixels are not guessed. Since the source only contains the original open-eye appearance, the eye layers remain at their original anchors instead of inventing a blink or gaze.

The earlier `layers/` and `package/` folders contain an experimental generated draft and are not loaded by the demo. They are retained as historical work files; the current runtime uses only `source-layers/`.
