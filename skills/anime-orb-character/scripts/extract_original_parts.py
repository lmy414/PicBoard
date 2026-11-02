#!/usr/bin/env python3
"""Cut aligned, source-pixel-only parts from a finished RGBA character image."""

from __future__ import annotations

import json
import sys
from collections import deque
from pathlib import Path

from PIL import Image


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit("Usage: python extract_original_parts.py <source.png> <output-dir> <manifest.json>")

    source_path = Path(sys.argv[1]).resolve()
    output_dir = Path(sys.argv[2]).resolve()
    manifest_path = Path(sys.argv[3]).resolve()
    source = Image.open(source_path).convert("RGBA")
    width, height = source.size
    src = source.load()

    # These bounds isolate the two existing eye shapes. They are cut from the
    # source as-is; no alternate gaze, eyelid, or hidden skin is synthesized.
    eye_regions = {
        "eye-left": (0.155, 0.585, 0.265, 0.745),
        "eye-right": (0.435, 0.700, 0.545, 0.850),
    }
    # The face selection follows the warm skin and blush colors in the face
    # silhouette. Remaining anti-aliased outlines/highlights stay in support.
    face_region = (0.035, 0.435, 0.650, 1.0)
    # Blue-dominant and cool, near-white source pixels, split into non-
    # overlapping spatial cutouts. The latter catches the pale blue/lilac
    # fringe highlights without including the warmer face color.
    hair_regions = [
        ("hair-crown", (0.015, 0.075, 0.445, 0.385)),
        ("hair-side-left", (0.000, 0.365, 0.180, 0.795)),
        ("hair-fringe-left", (0.000, 0.305, 0.470, 0.770)),
        ("hair-fringe-right", (0.445, 0.300, 0.795, 0.790)),
        ("hair-side-right", (0.795, 0.360, 1.000, 0.845)),
        ("hair-tips-lower", (0.000, 0.770, 0.880, 1.000)),
    ]

    def px_bounds(bounds: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
        left, top, right, bottom = bounds
        return (int(left * width), int(top * height), min(width, int(right * width)), min(height, int(bottom * height)))

    def inside(x: int, y: int, bounds: tuple[float, float, float, float]) -> bool:
        x0, y0, x1, y1 = px_bounds(bounds)
        return x0 <= x < x1 and y0 <= y < y1

    labels = Image.new("L", source.size, 0)
    label_px = labels.load()
    layers: list[tuple[str, int, str]] = []
    next_label = 1

    # Select each eye by its existing dark pixels and soft anti-aliased edge.
    for layer_id, bounds in eye_regions.items():
        label = next_label
        next_label += 1
        x0, y0, x1, y1 = px_bounds(bounds)
        width_eye = x1 - x0
        height_eye = y1 - y0
        candidates = bytearray(width_eye * height_eye)
        visited = bytearray(width_eye * height_eye)
        for ry in range(height_eye):
            for rx in range(width_eye):
                red, green, blue, alpha = src[x0 + rx, y0 + ry]
                luminance = (red * 299 + green * 587 + blue * 114) // 1000
                if alpha > 0 and luminance < 225:
                    candidates[ry * width_eye + rx] = 1

        largest: list[int] = []
        for start, possible in enumerate(candidates):
            if not possible or visited[start]:
                continue
            queue = deque([start])
            visited[start] = 1
            component: list[int] = []
            while queue:
                current = queue.popleft()
                component.append(current)
                cy, cx = divmod(current, width_eye)
                for ny in range(max(0, cy - 1), min(height_eye, cy + 2)):
                    for nx in range(max(0, cx - 1), min(width_eye, cx + 2)):
                        neighbor = ny * width_eye + nx
                        if candidates[neighbor] and not visited[neighbor]:
                            visited[neighbor] = 1
                            queue.append(neighbor)
            if len(component) > len(largest):
                largest = component

        if len(largest) < 3000:
            raise SystemExit(f"No source pixels found for {layer_id}")
        for local_index in largest:
            ry, rx = divmod(local_index, width_eye)
            label_px[x0 + rx, y0 + ry] = label
        layers.append((layer_id, label, "extracted"))

    face_label = next_label
    next_label += 1
    face_count = 0
    for y in range(height):
        for x in range(width):
            if label_px[x, y] or not inside(x, y, face_region):
                continue
            red, green, blue, alpha = src[x, y]
            warm_skin = alpha > 0 and red >= 175 and red >= green - 8 and green >= blue + 7
            if warm_skin:
                label_px[x, y] = face_label
                face_count += 1
    layers.append(("face", face_label, "extracted"))

    for layer_id, bounds in hair_regions:
        label = next_label
        next_label += 1
        count = 0
        for y in range(height):
            for x in range(width):
                if label_px[x, y] or not inside(x, y, bounds):
                    continue
                red, green, blue, alpha = src[x, y]
                blue_hair = blue > red + 18 and green > red + 8
                cool_hair_light = min(red, green, blue) > 150 and abs(blue - red) <= 12 and red >= green + 2
                if alpha > 0 and (blue_hair or cool_hair_light):
                    label_px[x, y] = label
                    count += 1
        if count:
            layers.append((layer_id, label, "extracted"))

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_layers = []
    rebuilt = Image.new("RGBA", source.size, (0, 0, 0, 0))
    for layer_id, label, provenance in layers:
        mask = labels.point(lambda value, target=label: 255 if value == target else 0)
        cutout = Image.new("RGBA", source.size, (0, 0, 0, 0))
        cutout.paste(source, mask=mask)
        cutout.save(output_dir / f"{layer_id}.png", optimize=True)
        rebuilt.alpha_composite(cutout)
        manifest_layers.append({"id": layer_id, "file": f"{layer_id}.png", "provenance": provenance, "canvas": [width, height]})

    # All untouched source pixels are retained in one aligned support layer.
    support_label = labels.point(lambda value: 0 if value else 255)
    support = Image.new("RGBA", source.size, (0, 0, 0, 0))
    support.paste(source, mask=support_label)
    support.save(output_dir / "source-support.png", optimize=True)
    rebuilt.alpha_composite(support)
    rebuilt.save(output_dir / "reassembled-preview.png", optimize=True)

    manifest = {
        "source": "../source-reference.png",
        "canvas": [width, height],
        "provenance": "Every visible pixel comes from the supplied source image. No new face, eye, or hair pixels are drawn.",
        "cropCompletion": "none; the source canvas already clips hair at its edges, and those hidden pixels are not guessed.",
        "layers": manifest_layers + [{"id": "source-support", "file": "source-support.png", "provenance": "extracted-remainder", "canvas": [width, height]}],
        "limitations": [
            "Only the original open-eye appearance exists in the source; alternate eye expressions require additional source artwork.",
            "The source is partitioned into disjoint aligned pixel masks. Moving a cutout can expose transparent gaps where the original did not contain hidden pixels.",
        ],
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Extracted {len(layers)} aligned layers and source support at {width}x{height}.")
    print(f"Preview: {output_dir / 'reassembled-preview.png'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
