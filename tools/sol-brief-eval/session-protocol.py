"""Exercise DSH tool calls deterministically, independently of text quality."""
import json
import os
import secrets
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOOLS = {"get_selected_product", "get_brand_context", "get_project_context"}
seen = []


class ModelProtocol(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        assert self.path == "/v1/chat/completions"
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert {x["function"]["name"] for x in req["tools"]} == TOOLS
        seen.append(req)
        answered = req["messages"][-1]["role"] == "tool"
        if answered:
            assert "protocol-brand" in str(req["messages"][-1]["content"])
            delta = {"role": "assistant", "content": "READ_OK"}
        else:
            delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_read", "type": "function",
                     "function": {"name": "get_brand_context", "arguments": "{}"}}]}
        chunks = [{"delta": delta, "finish_reason": None},
                  {"delta": {}, "finish_reason": "stop" if answered else "tool_calls"}]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for choice in chunks:
            wire = {"id": "test", "object": "chat.completion.chunk", "created": 1, "model": "protocol",
                    "choices": [{"index": 0, **choice}]}
            self.wfile.write(("data: " + json.dumps(wire) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")


def run():
    server = ThreadingHTTPServer(("127.0.0.1", 0), ModelProtocol)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory() as root:
            env = {**os.environ, "SOL_DSH_HOME": root, "SOL_DSH_MODEL": "protocol",
                   "SOL_DSH_MODEL_URL": f"http://127.0.0.1:{server.server_port}/v1"}
            sid = secrets.token_hex(32)
            def invoke(**overrides):
                job = {"sessionId": sid, "prompt": "Check brand", "facts": {"brand": "protocol-brand"}, **overrides}
                return subprocess.run([env["SOL_DSH_EXECUTABLE"]], env=env, input=json.dumps(job), text=True,
                                      capture_output=True, timeout=35, encoding="utf-8")
            first = invoke()
            assert first.returncode == 0, first.stderr
            result = json.loads(first.stdout)
            assert result["text"] == "READ_OK"
            assert [r for r in result["reads"] if r["source"] == "agent"] == [{"source": "agent", "name": "get_brand_context"}]
            assert {r["name"] for r in result["reads"] if r["source"] == "snapshot"} == TOOLS
            assert len(seen) == 2
            restored = invoke(resume=True, readOnly=True)
            assert restored.returncode == 0, restored.stderr
            assert json.loads(restored.stdout)["recoveryToolCalls"] == 0
            missing = invoke(sessionId=secrets.token_hex(32), resume=True, readOnly=True)
            assert missing.returncode != 0 and len(seen) == 2
            print(json.dumps({"scriptedProviderTurns": 2, "nativeTool": "get_brand_context",
                              "visibleTools": sorted(TOOLS), "restoreProviderCalls": 0, "unknownSessionRejected": True}))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    run()
