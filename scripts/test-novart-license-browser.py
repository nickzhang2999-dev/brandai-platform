"""Exercise real native licensing on loopback HTTP and local non-loopback HTTPS.

The HTTPS name resolves only inside the disposable test browser. Neither the
SDK's license checks nor its license key are replaced. A production refusal is
expected: this verifies that it becomes visible, not that deployment is licensed.
Requires cryptography plus Node/playwright-core and a Chromium installation.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

REPO = Path(__file__).resolve().parents[1]
PACKAGE = REPO / "previews" / "novart-workbench"
sys.path.insert(0, str(PACKAGE / "harness"))
from share_runtime import ShareRuntime

TEST_HOST = "novart-canvas.test"


def configure_test_tls(runtime, directory):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, TEST_HOST)])
    now = datetime.datetime.now(datetime.timezone.utc)
    certificate = (
        x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(TEST_HOST)]), critical=False)
        .sign(key, hashes.SHA256())
    )
    key_path, certificate_path = directory / "test.key", directory / "test.crt"
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    certificate_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate_path, key_path)
    runtime.server.socket = context.wrap_socket(runtime.server.socket, server_side=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, help="Optional content-free JSON result path")
    options = parser.parse_args()
    sharing = (PACKAGE / "sharing").resolve()
    sharing.mkdir(exist_ok=True)
    reports = []
    for mode in ("loopback-http", "production-https"):
        with tempfile.TemporaryDirectory(prefix="native-license-test-", dir=sharing) as temporary:
            directory = Path(temporary).resolve()
            if directory.parent != sharing or not directory.name.startswith("native-license-test-"):
                raise RuntimeError("Test directory escaped isolated sharing root")
            runtime = ShareRuntime(directory)
            try:
                if mode == "production-https":
                    configure_test_tls(runtime, directory)
                runtime.start()
                port = runtime.server.server_port
                origin = (f"https://{TEST_HOST}:{port}" if mode == "production-https"
                    else f"http://127.0.0.1:{port}")
                config_path, report_path = directory / "browser-config.json", directory / "result.json"
                config_path.write_text(json.dumps({"mode": mode, "origin": origin, "port": port,
                    "entry": "/share/" + runtime.key, "reportPath": str(report_path)}), encoding="utf-8")
                environment = {**os.environ, "TEMP": str(directory), "TMP": str(directory)}
                result = subprocess.run(["node", str(Path(__file__).with_suffix(".cjs")), str(config_path)],
                    cwd=REPO, env=environment, timeout=100)
                if report_path.is_file():
                    reports.append(json.loads(report_path.read_text(encoding="utf-8")))
                if result.returncode:
                    if options.report:
                        options.report.parent.mkdir(parents=True, exist_ok=True)
                        options.report.write_text(json.dumps({"passed": False, "cases": reports},
                            ensure_ascii=False, indent=2), encoding="utf-8")
                    raise RuntimeError(f"{mode} browser regression failed")
            finally:
                runtime.close()
    summary = {"passed": True, "productionLicenseUsable": False,
        "meaning": "Development stability and visible production license refusal verified", "cases": reports}
    if options.report:
        options.report.parent.mkdir(parents=True, exist_ok=True)
        options.report.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": True, "cases": len(reports), "productionLicenseUsable": False}))


if __name__ == "__main__":
    main()
