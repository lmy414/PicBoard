# Anime Orb Character

A shareable Codex skill for turning one character illustration into aligned transparent layers, expression states, and a motion-ready character pack.

## Install

Copy the `anime-orb-character` folder into your Codex skills directory, usually `%USERPROFILE%\.codex\skills\anime-orb-character`. Restart or refresh Codex skill discovery, then ask it to split supplied character art into a floating-orb pack.

## Package a finished character

The optional validator requires Pillow:

```powershell
python -m pip install Pillow
python scripts/package_character.py path\to\character-pack path\to\output
```

The output contains a copy of the manifest and every referenced PNG, plus one transparent preview per state. Read `references/asset-contract.md` for the pack format.
