"""Loopback image transport fixture. Verifies real input bytes and returns a labeled test poster."""
import base64
import hashlib
import io
import json
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageOps


class Provider(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/v1/images/edits":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers["Content-Length"]))
        message = BytesParser(policy=policy.default).parsebytes(
            ("Content-Type: " + self.headers["Content-Type"] + "\r\n\r\n").encode() + body)
        parts = list(message.iter_parts())
        images = [part.get_payload(decode=True) for part in parts if part.get_filename()]
        prompt = next((part.get_payload(decode=True).decode() for part in parts
                       if part.get_param("name", header="Content-Disposition") == "prompt"), "")
        entry = {"referenceHashes": [hashlib.sha256(b).hexdigest() for b in images],
                 "layout": "本次仅生成一张商品外观海报。构图：轮廓留白。" in prompt,
                 "audience": "受众：大学生" in prompt,
                 "earlierRequirements": "夏季推广海报" in prompt and "背景保留纸张纹理" in prompt}
        with Path(sys.argv[1]).open("a", encoding="utf8") as log:
            print(json.dumps(entry), file=log)
        if not all(entry.values()):
            self.send_error(422)
            return
        image = Image.new("RGB", (1024, 1024), "#e5efef")
        with Image.open(io.BytesIO(images[0])) as original:
            product = ImageOps.contain(original.convert("RGB"), (730, 780))
            image.paste(product, ((1024 - product.width) // 2, 80))
        ImageDraw.Draw(image).text((54, 930), "SOL / LOCAL TRANSPORT FIXTURE", fill="black")
        output = io.BytesIO()
        image.save(output, "PNG")
        data = json.dumps({"data": [{"b64_json": base64.b64encode(output.getvalue()).decode()}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 26492), Provider).serve_forever()
