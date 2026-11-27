"""Compare the two compiled clients on loopback, with real local inference or fault injection."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
PRODUCTS = [json.loads(path.read_text(encoding="utf-8")) for path in sorted((ROOT / "fixtures").glob("*.json"))]
SKILL = (ROOT / "brand-poster-skill.md").read_text(encoding="utf-8").strip()
MODEL = "local-qwen"
ADAPTERS = ("rig", "async-openai")


def text_content(content):
    if isinstance(content, str):
        return content
    if not all(part["type"] == "text" for part in content):
        raise ValueError("unexpected content type")
    return "".join(part["text"] for part in content)


def handler(state, llm):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *unused):
            pass

        def reply(self, code, data):
            payload = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self):
            state["paths"].append(self.path)
            try:
                if self.path != "/v1/chat/completions":
                    raise ValueError("unexpected route")
                data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                messages = [{"role": m["role"], "content": text_content(m["content"])} for m in data["messages"]]
                if [m["role"] for m in messages] != ["system", "user"] or messages[0]["content"].strip() != SKILL:
                    raise ValueError("unexpected messages")
                selection = json.loads(messages[1]["content"])["selection"]
                if (selection != state["product"] or data.get("tools") or data["model"] != MODEL
                        or abs(data["temperature"] - 0.2) > 1e-5 or data["max_tokens"] != 320
                        or data["response_format"] != {"type": "json_object"}):
                    raise ValueError("selection, model or tool mismatch")
                mode = state["mode"]
                if mode == "timeout":
                    time.sleep(0.5)
                    return
                if mode == "rate-limit":
                    self.reply(429, {"error": {"message": "test rate limit", "type": "rate_limit_error"}})
                    return
                if mode == "inference":
                    result = llm.create_chat_completion(messages=messages, model=MODEL, temperature=data["temperature"],
                        max_tokens=data["max_tokens"], response_format=data["response_format"], seed=42)
                    state["inference_text"] = result["choices"][0]["message"]["content"]
                else:
                    # A protocol fault, never used as a successful inference sample.
                    message = {"role": "assistant", "content": "{}"}
                    if mode == "tool-call":
                        message = {"role":"assistant", "content":None, "tool_calls":[{"id":"x1","type":"function",
                            "function":{"name":"submit_generation","arguments":"{}"}}]}
                    if mode == "foreign-brief":
                        message["content"] = json.dumps({"sku":"ST-02","appearance":"正面主视","scene":"书桌",
                            "detail":"局部放大"}, ensure_ascii=False)
                    if mode in ("unapproved-claim","truncated"):
                        product = state["product"]
                        choices = {"sku":product["sku"],"appearance":"正面主视",
                            "scene":product["settings"][0],"detail":"局部放大"}
                        if mode == "unapproved-claim":
                            choices["claim"] = product["unconfirmed"]
                        message["content"] = json.dumps(choices, ensure_ascii=False)
                    finish = {"tool-call":"tool_calls","truncated":"length"}.get(mode,"stop")
                    result = {"id":"local-fault", "object":"chat.completion", "created":1, "model":MODEL, "choices":[
                        {"index":0, "finish_reason":finish, "message":message}],
                        "usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}
                self.reply(200, result)
            except Exception as exc:
                state["gateway_error"] = type(exc).__name__ + ": " + str(exc)
                self.reply(400, {"error":{"message":"invalid local evaluation request","type":"invalid_request_error"}})
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("--gguf", type=Path, help="run actual CPU inference on the two fixture products")
    parser.add_argument("--app-python", type=Path, help="Python with the Studio AI dependencies for a baseline")
    args = parser.parse_args()
    llm = None
    if args.gguf:
        from llama_cpp import Llama
        llm = Llama(model_path=str(args.gguf), n_ctx=2048, n_threads=3, seed=42, verbose=False)
    cases = [("inference", p) for p in PRODUCTS] if args.gguf else [
        (mode, PRODUCTS[0]) for mode in ("wrong-workspace", "wrong-project", "tool-call", "foreign-brief",
                                          "unapproved-claim", "truncated", "rate-limit", "timeout")]
    state = {}
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler(state, llm))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    results = []
    try:
        # WSL mirrored networking can briefly refuse a newly bound loopback port.
        # Probe only TCP readiness, before counting any inference requests.
        deadline = time.monotonic() + 3
        while True:
            try:
                with socket.create_connection(server.server_address, timeout=0.5):
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)
        for mode, product in cases:
            adapters = ("existing-python", *ADAPTERS) if args.gguf and args.app_python else ADAPTERS
            for adapter in adapters:
                state.update(product=product, mode=mode, paths=[], gateway_error=None, inference_text=None)
                env = {**os.environ, "NO_PROXY":"127.0.0.1","no_proxy":"127.0.0.1",
                       "SOL_BRIEF_LOCAL_TIMEOUT_MS":"200" if mode == "timeout" else "90000"}
                workspace = "other" if mode == "wrong-workspace" else product["workspace"]
                project = "other" if mode == "wrong-project" else product["project"]
                started = time.monotonic()
                port = str(server.server_port)
                common = dict(capture_output=True, text=True, encoding="utf-8", env=env, timeout=100)
                command = [str(args.binary.resolve()), adapter, port, MODEL, workspace, project, product["sku"]]
                if adapter == "existing-python":
                    prompt = {"request": "给当前商品做三张推广海报，分别突出外观、使用场景和核心卖点。未确认的宣传说法先列出来。",
                              "selection":product}
                    model_reply = subprocess.run([str(args.app_python), str(ROOT/"baseline.py"), port, MODEL],
                        input=json.dumps(prompt, ensure_ascii=False, separators=(",", ":"), sort_keys=True), **common)
                    command[1] = "render-baseline"
                    proc = subprocess.run(command, input=model_reply.stdout, **common) if model_reply.returncode == 0 else model_reply
                else:
                    proc = subprocess.run(command, **common)
                paths = state["paths"][:]
                brief = json.loads(proc.stdout) if proc.returncode == 0 else None
                expect_posts = 0 if mode in ("wrong-workspace","wrong-project") else 1
                ok = (bool(brief) == (mode == "inference") and paths == ["/v1/chat/completions"] * expect_posts
                      and state["gateway_error"] is None)
                if brief and mode == "inference":
                    facts = {"skill":"brand-poster/v1","workspace":workspace,"project":project,
                             "sku":product["sku"],"source_revision":product["revision"],"product":product["product"],
                             "brand":product["brand"],"logo":product["mark"],"color":product["color"],
                             "typeface":product["typeface"],"protected":product["keep"],
                             "needs_confirmation":[product["unconfirmed"]]}
                    posters = brief.get("posters", [])
                    ok = (ok and all(brief.get(k) == v for k,v in facts.items()) and len(posters) == 3
                          and [x["purpose"] for x in posters] == ["外观","使用场景","已确认卖点"]
                          and posters[1].get("setting") in product["settings"]
                          and posters[2].get("copy") == product["copy"])
                results.append(dict(adapter=adapter, case=mode, sku=product["sku"], passed=ok, paths=paths,
                    elapsed_ms=round((time.monotonic()-started)*1000), brief=brief,
                    error=state["gateway_error"] or proc.stderr.strip() or None,
                    rejected_output=state["inference_text"] if not ok else None))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return int(any(not row["passed"] for row in results))


if __name__ == "__main__":
    sys.exit(main())
