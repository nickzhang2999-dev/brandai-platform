"""Summarize sanitized timing events from normal Web, Worker and AI service logs."""
import argparse
import json
from pathlib import Path
import re

LABEL = "[studio-delivery] "
STAGES = {"click_linked", "generation_claimed", "model_request_started", "provider_http_start",
          "provider_http_return", "provider_http_interrupted", "model_response_received",
          "artifact_enqueue", "worker_claimed", "asset_persisted", "canvas_visible"}


def collect(files):
    requests = {}
    for path in files:
        with path.open(encoding="utf-8-sig", errors="replace") as stream:
            for line in stream:
                _, found, payload = line.partition(LABEL)
                if not found:
                    continue
                try:
                    e = json.JSONDecoder().raw_decode(payload.lstrip())[0]
                except ValueError:
                    continue
                if not isinstance(e, dict):
                    continue
                rid, stage = e.get("requestId"), e.get("stage")
                if not isinstance(rid, str) or not re.fullmatch(r"sgr_[a-f0-9]{32}", rid) or stage not in STAGES:
                    continue
                row = requests.setdefault(rid, {})
                row.setdefault(stage, []).append({k: e[k] for k in ("at","receivedAt","clickAt","durationMs","clickToReadableMs","status","outputId","assetId") if k in e})
    return requests


def summarize(groups):
    for rid, s in sorted(groups.items()):
        def first(stage, field):
            values = [e[field] for e in s.get(stage, []) if isinstance(e.get(field), (float, int))]
            return min(values) if values else None
        def gap(begin, end):
            return end-begin if begin is not None and end is not None else None
        click = first("click_linked","clickAt")
        claim = first("generation_claimed","at")
        yield {"requestId":rid,"clickToClaimApproxMs":gap(click,claim),
               "claimToAiSendMs":gap(claim,first("model_request_started","at")),
               "providerPostObservations":len(s["provider_http_start"]) if "provider_http_start" in s else None,
               "providerResponses":s.get("provider_http_return",[]),
               "providerInterruptions":s.get("provider_http_interrupted",[]),
               "firstClickToVisibleMs":first("canvas_visible","durationMs"),
               "missingStages":sorted(STAGES.difference({"provider_http_interrupted"},s)),
               "events":s}


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("logs", type=Path, nargs="+")
    print(json.dumps(list(summarize(collect(cli.parse_args().logs))),ensure_ascii=False,indent=2))
