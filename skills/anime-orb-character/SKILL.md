---
name: anime-orb-character
description: Turn supplied character artwork into a layered, animated floating-orb character pack. Use when extracting or creating transparent character parts, expressions, and motion-ready assets for a desktop mascot.
---

# Anime orb character asset workflow

Use the supplied image as the character identity source. Build a compact head-shaped mascot with reusable artwork layers, expression states, and a small motion specification. This skill produces a reviewable asset pack; it does not change the consuming application's renderer unless that is separately requested.

## Workflow

1. Inspect the source dimensions, alpha channel, crop, and visible overlaps. Record what can be cut out directly and what must be reconstructed behind an occluding part. Keep the source image unchanged. If it already contains the finished face and hair, preserve it as the master portrait layer; do not redraw or regenerate facial features unless the user asks.
2. Define one shared canvas, head center, eye line, mouth anchor, and hair pivots before making variants. Preserve identical canvas dimensions and alignment across layers and expressions.
3. Separate useful motion parts only where the source supports a clean cut: back hair, front fringe, hair tips, accessories, or facial details. Prefer exact source-pixel masks on a shared canvas. When cutting would expose missing face pixels, keep the complete master portrait intact and use small motion overlays from visible source pixels; do not paint a replacement face to force a split. Create new face or expression art only when requested. Keep clean transparent PNG edges and label extracted, reconstructed, and generated areas in the manifest and preview notes.
4. Make a small state set tied to real interaction: idle, pointer attention, grabbed/dragged, image received, swallow, success, and error. Idle may blink, sway, and breathe gently. Drag and intake states may squash, tilt, stretch, and spring back. Keep motion cues readable at the actual collapsed-window size; avoid constant high-amplitude motion.
5. Keep physics data as tunable visual parameters (rest scale, squash/stretch, rotation, spring, damping, settle time). Do not claim a simulation is implemented when the pack only supplies art and motion parameters.
6. Write `character.json` using [references/asset-contract.md](references/asset-contract.md). Run `scripts/package_character.py` to validate canvas alignment, alpha, layer references, and the idle composite. Review the generated preview over a checkerboard and at target display size.
7. Deliver the unchanged source reference only when the user has rights to share it. Keep each character pack independent so people can distribute their own character without editing the skill.

## Source fidelity

- Distinguish `extracted` pixels from `reconstructed` pixels in the manifest.
- Do not present an AI-generated sprite sheet as a pixel-accurate extraction. If an image tool merges layers, use it only as a visual draft and request or make individual aligned transparent layers before calling the pack ready.
- If an input is cropped, state which silhouette or hidden region cannot be recovered from that file. Do not invent those missing parts silently.
- If the supplied art is already a complete character image, keep that exact image available as the base layer and verify all cutouts over it. Do not replace the face with a newly generated one as a shortcut for alignment.
- Prefer one character identity per pack. Ask only when the intended character, source image, or output ownership is genuinely ambiguous.

## Resources

- Read [references/asset-contract.md](references/asset-contract.md) for the pack format, layer names, state mapping, and motion fields.
- Read [references/layer-prompts.md](references/layer-prompts.md) when prompting an image tool for separated parts; generate one aligned layer per image, not a collage.
- For a finished transparent portrait, use `scripts/extract_source_slices.py <source.png> <regions.json> <output-dir>` to make exact pixel cutouts from configured regions without redrawing the face. Set `selection` to `blue-dominant` for blue hair accents or `all-alpha` for an unrestricted region.
- Use `scripts/package_character.py <input-dir> <output-dir>` to validate a finished pack and create a transparent composite preview.
- `assets/template-character.json` is a starter manifest. Replace its placeholder values before packaging.
