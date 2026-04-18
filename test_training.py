"""Standalone runner for the training pipeline.

Usage:
    python test_training.py sessions/test_session_001/

Expects the folder to contain:
    audio.wav (or audio.webm/mp3/m4a)
    video.webm (optional)
    volume.json (optional) — [{ "t": seconds, "dbfs": -40.0 }, ...]

Writes report.json into the same folder.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

from services.training_processor import process_session


def _load_config() -> dict:
    root = Path(__file__).parent
    return json.loads((root / "config.json").read_text())


async def main(session_dir: str) -> None:
    load_dotenv()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    config = _load_config()
    result = await process_session(session_dir, config)
    print(json.dumps(result["report"], indent=2))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python test_training.py <session_dir>")
        sys.exit(1)
    asyncio.run(main(sys.argv[1]))
