# Character asset pack contract

Each pack has one `character.json` file and one or more transparent PNG layers. All PNGs that participate in the same composition use the exact canvas width and height; do not crop each layer to its visible bounds. This keeps overlay anchors stable and avoids per-frame drift.

## Required manifest fields

```json
{
  "schemaVersion": 1,
  "id": "cyan-head",
  "name": "Cyan Head",
  "canvas": { "width": 512, "height": 512, "headAnchor": [256, 276] },
  "layers": {
    "hairBack": { "file": "layers/hair-back.png", "z": 10, "provenance": "extracted" },
    "head": { "file": "layers/head.png", "z": 20, "provenance": "reconstructed" },
    "eyesOpen": { "file": "layers/eyes-open.png", "z": 30, "provenance": "extracted" },
    "mouthNeutral": { "file": "layers/mouth-neutral.png", "z": 40, "provenance": "reconstructed" },
    "hairFront": { "file": "layers/hair-front.png", "z": 50, "provenance": "extracted" }
  },
  "states": {
    "idle": ["hairBack", "head", "eyesOpen", "mouthNeutral", "hairFront"],
    "dragged": ["hairBack", "head", "eyesOpen", "mouthNeutral", "hairFront"],
    "receiving": ["hairBack", "head", "eyesOpen", "mouthOpen", "hairFront"]
  },
  "motion": {
    "idle": { "swayDeg": 2, "bobPx": 2, "blinkIntervalSec": [2.5, 5.5] },
    "dragged": { "tiltDeg": 10, "squash": 0.12, "spring": 0.72, "damping": 0.78 },
    "receiving": { "squash": 0.18, "spring": 0.8, "damping": 0.72 }
  }
}
```

Layer IDs are pack-local and camelCase. `file` paths are relative to the pack directory. `provenance` is `extracted`, `reconstructed`, or `generated`; use the value that describes the actual pixels. `states` are ordered bottom-to-top. Motion values describe a proposed renderer contract, not a promise that every host already implements them.

The current checker validates manifest identity, paths, PNG format, shared canvas dimensions, alpha channels, state references, and a rendered `idle` preview. It does not judge whether a source extraction is faithful or whether the character looks good at 88 pixels; inspect those visually.
