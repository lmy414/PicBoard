#!/usr/bin/env python3
"""Extract exact color-selected regions from a finished transparent portrait."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image


def fail(message: str) -> None:
    raise SystemExit(f"Source slice extraction failed: {message}")


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit("Usage: python extract_source_slices.py <source.png> <regions.json> <output-dir>")

    source_path = Path(sys.argv[1]).resolve()
    config_path = Path(sys.argv[2]).resolve()
    output_dir = Path(sys.argv[3]).resolve()
    if not source_path.is_file() or not config_path.is_file():
        fail("source image and region configuration must both exist")

    source = Image.open(source_path).convert("RGBA")
    width, height = source.size
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    selection = config.get("selection", "all-alpha")
    if selection not in {"all-alpha", "blue-dominant"}:
        fail("selection must be all-alpha or blue-dominant")
    regions = config.get("slices")
    if not isinstance(regions, list) or not regions:
        fail("slices must be a non-empty list")

    output_dir.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    source_pixels = source.load()
    for region in regions:
        layer_id = region.get("id")
        bounds = region.get("bounds")
        if not isinstance(layer_id, str) or not layer_id or layer_id in seen:
            fail("each slice needs a unique non-empty id")
        seen.add(layer_id)
        if not isinstance(bounds, list) or len(bounds) != 4 or not all(isinstance(v, (int, float)) for v in bounds):
            fail(f"slice {layer_id!r} needs normalized [left, top, right, bottom] bounds")
        left, top, right, bottom = bounds
        if not (0 <= left < right <= 1 and 0 <= top < bottom <= 1):
            fail(f"slice {layer_id!r} bounds must be normalized and inside the canvas")

        x0, y0 = int(left * width), int(top * height)
        x1, y1 = min(width, int(right * width)), min(height, int(bottom * height))
        out = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        out_pixels = out.load()
        selected = 0
        for y in range(y0, y1):
            for x in range(x0, x1):
                red, green, blue, alpha = source_pixels[x, y]
                keep = alpha > 0 and (
                    selection == "all-alpha"
                    or (blue > red + 18 and green > red + 8)
                )
                if keep:
                    out_pixels[x, y] = (red, green, blue, alpha)
                    selected += 1
        if selected == 0:
            fail(f"slice {layer_id!r} selected no visible source pixels")
        out.save(output_dir / f"{layer_id}.png", optimize=True)
        print(f"{layer_id}: {selected} source pixels -> {output_dir / f'{layer_id}.png'}")

    print(f"Canvas preserved at {width}x{height}; source pixels were not recolored or reconstructed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
