"""Exercise the existing Studio JSON client with a synthetic selection on loopback."""
import asyncio
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parents[1] / "apps" / "ai"))
from app.providers.http_providers import HttpVLMProvider


async def main():
    port, model = sys.argv[1:]
    prompt = sys.stdin.read()
    provider = HttpVLMProvider(f"http://127.0.0.1:{int(port)}/v1", "local-only", model)
    brief = await provider._chat_json(
        [{"type":"text", "text":prompt}], system=(ROOT / "brand-poster-skill.md").read_text(encoding="utf-8"),
        max_tokens=320)
    print(json.dumps(brief, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
