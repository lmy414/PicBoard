#!/usr/bin/env python3
"""Validate an aligned transparent character pack and render its idle state."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError as exc:
    raise SystemExit("This helper requires Pillow. Install it with: python -m pip install Pillow") from exc


def fail(message: str) -> None:
    raise SystemExit(f"Character pack invalid: {message}")


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python package_character.py <input-pack-dir> <output-dir>")

    source = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    manifest_path = source / "character.json"
    if not manifest_path.is_file():
        fail(f"missing {manifest_path}")

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"character.json cannot be read: {exc}")

    if manifest.get("schemaVersion") != 1:
        fail("schemaVersion must be 1")
    for field in ("id", "name"):
        if not isinstance(manifest.get(field), str) or not manifest[field].strip():
            fail(f"{field} must be a non-empty string")

    canvas = manifest.get("canvas")
    if not isinstance(canvas, dict):
        fail("canvas object is required")
    try:
        width, height = int(canvas["width"]), int(canvas["height"])
    except (KeyError, TypeError, ValueError):
        fail("canvas.width and canvas.height must be positive integers")
    if width <= 0 or height <= 0:
        fail("canvas.width and canvas.height must be positive integers")

    layers = manifest.get("layers")
    if not isinstance(layers, dict) or not layers:
        fail("layers must be a non-empty object")

    loaded: dict[str, Image.Image] = {}
    source_files: dict[str, Path] = {}
    for layer_id, spec in layers.items():
        if not isinstance(spec, dict) or not isinstance(spec.get("file"), str):
            fail(f"layer {layer_id!r} needs a relative file path")
        rel = Path(spec["file"])
        if rel.is_absolute():
            fail(f"layer {layer_id!r} path must be relative")
        asset_path = (source / rel).resolve()
        if source not in asset_path.parents or not asset_path.is_file():
            fail(f"layer {layer_id!r} path is missing or escapes the pack directory")
        try:
            image = Image.open(asset_path)
            image.load()
        except Exception as exc:  # Pillow reports several file/decoder errors.
            fail(f"layer {layer_id!r} is not a readable image: {exc}")
        if image.format != "PNG" or image.mode != "RGBA":
            fail(f"layer {layer_id!r} must be a PNG with RGBA transparency")
        if image.size != (width, height):
            fail(f"layer {layer_id!r} is {image.width}x{image.height}; expected {width}x{height}")
        if image.getchannel("A").getbbox() is None:
            fail(f"layer {layer_id!r} is fully transparent")
        provenance = spec.get("provenance")
        if provenance not in {"extracted", "reconstructed", "generated"}:
            fail(f"layer {layer_id!r} provenance must be extracted, reconstructed, or generated")
        loaded[layer_id] = image
        source_files[layer_id] = asset_path

    states = manifest.get("states")
    if not isinstance(states, dict) or not isinstance(states.get("idle"), list):
        fail("states.idle must be an ordered list of layer IDs")
    for state_name, stack in states.items():
        if not isinstance(stack, list) or not stack:
            fail(f"state {state_name!r} must be a non-empty ordered list")
        unknown = [layer_id for layer_id in stack if layer_id not in loaded]
        if unknown:
            fail(f"state {state_name!r} references unknown layers: {', '.join(unknown)}")

    output.mkdir(parents=True, exist_ok=True)
    for layer_id, asset_path in source_files.items():
        rel = Path(layers[layer_id]["file"])
        packaged_path = output / rel
        packaged_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(asset_path, packaged_path)
    preview_paths: list[Path] = []
    for state_name, stack in states.items():
        preview = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        for layer_id in stack:
            preview.alpha_composite(loaded[layer_id])
        preview_path = output / "previews" / f"{state_name}.png"
        preview_path.parent.mkdir(parents=True, exist_ok=True)
        preview.save(preview_path)
        preview_paths.append(preview_path)

    (output / "character.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Validated {len(loaded)} layers and {len(states)} states.")
    print(f"Rendered {len(preview_paths)} state previews in {output / 'previews'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
