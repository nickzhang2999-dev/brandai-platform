"""Local persistence for the unmodified editor's SHAKKERDATA canvas payload.

This module knows storage, not Lovart HTTP response envelopes. Projects are
independent JSON files; every mutation uses a process lock and atomic replace.
Canvas validation never re-encodes or otherwise changes the supplied string.
"""
from __future__ import annotations

import base64
import binascii
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
import threading
import time
import uuid
import zlib


CANVAS_PREFIX = "SHAKKERDATA://"
_PROJECT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}\Z")
_DIGEST = re.compile(r"[a-f0-9]{64}\Z")
_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()
_MIMES = {"image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/avif"}


class StoreError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _integer(value, minimum, maximum):
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum


def _reject_constant(value):
    raise ValueError("Non-finite JSON number")


def _finite_float(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Non-finite JSON number")
    return result


def _valid_text(value):
    try:
        value.encode("utf-8")
        return True
    except UnicodeError:
        return False


class LocalStore:
    def __init__(self, data_dir, *, max_canvas_bytes=16 * 1024 * 1024,
                 max_decoded_bytes=64 * 1024 * 1024, max_asset_bytes=32 * 1024 * 1024):
        for value in (max_canvas_bytes, max_decoded_bytes, max_asset_bytes):
            if not _integer(value, 1, 1024 * 1024 * 1024):
                raise StoreError("INVALID_INPUT", "Size limits must be positive integers")
        self.max_canvas_bytes = max_canvas_bytes
        self.max_decoded_bytes = max_decoded_bytes
        self.max_asset_bytes = max_asset_bytes
        self.data_dir = Path(data_dir).resolve()
        self.projects_dir = self.data_dir / "projects"
        self.assets_dir = self.data_dir / "assets"
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            for directory in (self.projects_dir, self.assets_dir):
                self._check_directory(directory)
                directory.mkdir(exist_ok=True)
        except OSError as exc:
            raise StoreError("STORE_IO", "Cannot initialize local storage") from exc
        with _LOCKS_GUARD:
            self._thread_lock = _LOCKS.setdefault(str(self.data_dir), threading.RLock())

    def _check_directory(self, directory):
        if directory.is_symlink() or (hasattr(directory, "is_junction") and directory.is_junction()):
            raise StoreError("INVALID_PATH", "Storage directories cannot be links")
        if directory.resolve().parent != self.data_dir:
            raise StoreError("INVALID_PATH", "Storage path escaped its root")

    def _path(self, directory, name):
        self._check_directory(directory)
        path = directory / name
        if path.is_symlink() or path.resolve().parent != directory.resolve():
            raise StoreError("INVALID_PATH", "Storage file cannot be a link or escape its directory")
        return path

    @contextmanager
    def _locked(self):
        """Serialize readers/writers across LocalStore instances and processes."""
        with self._thread_lock:
            lock_path = self.data_dir / ".store.lock"
            if lock_path.is_symlink() or lock_path.resolve().parent != self.data_dir:
                raise StoreError("INVALID_PATH", "Invalid storage lock path")
            stream = None
            acquired = False
            try:
                stream = lock_path.open("a+b")
                if stream.tell() == 0:
                    stream.write(b"\0")
                    stream.flush()
                deadline = time.monotonic() + 5
                while True:
                    try:
                        stream.seek(0)
                        if os.name == "nt":
                            import msvcrt
                            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                        else:
                            import fcntl
                            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        acquired = True
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise StoreError("STORE_BUSY", "Storage is busy; retry the operation")
                        time.sleep(0.025)
                yield
            except OSError as exc:
                raise StoreError("STORE_IO", "Local storage operation failed") from exc
            finally:
                if stream is not None:
                    if acquired:
                        stream.seek(0)
                        if os.name == "nt":
                            import msvcrt
                            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                        else:
                            import fcntl
                            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
                    stream.close()

    @staticmethod
    def _project_id(value):
        if not isinstance(value, str) or not _PROJECT_ID.fullmatch(value):
            raise StoreError("INVALID_PROJECT_ID", "Project ID must contain only letters, digits, _ or -")
        return value

    @staticmethod
    def _payload(payload):
        if not isinstance(payload, dict):
            raise StoreError("INVALID_INPUT", "Project payload must be an object")

    def _validate_canvas(self, canvas, *, allow_empty=False):
        if not isinstance(canvas, str):
            raise StoreError("INVALID_CANVAS", "Canvas must be the original serialized string")
        if canvas == "" and allow_empty:
            return
        if len(canvas) > self.max_canvas_bytes:
            raise StoreError("CANVAS_TOO_LARGE", "Serialized canvas exceeds the size limit")
        if not canvas.startswith(CANVAS_PREFIX):
            raise StoreError("INVALID_CANVAS", "Expected the original SHAKKERDATA canvas format")
        try:
            compressed = base64.b64decode(canvas[len(CANVAS_PREFIX):], validate=True)
            inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
            decoded = inflater.decompress(compressed, self.max_decoded_bytes + 1)
            if len(decoded) > self.max_decoded_bytes or inflater.unconsumed_tail:
                raise StoreError("CANVAS_TOO_LARGE", "Decompressed canvas exceeds the size limit")
            if not inflater.eof or inflater.unused_data:
                raise ValueError("Incomplete gzip or trailing data")
            document = json.loads(decoded.decode("utf-8"), parse_constant=_reject_constant, parse_float=_finite_float)
            snapshot = document.get("tldrawSnapshot") if isinstance(document, dict) else None
            inner = snapshot.get("document") if isinstance(snapshot, dict) else None
            if not isinstance(inner, dict) or not isinstance(inner.get("store"), dict) or not isinstance(inner.get("schema"), dict):
                raise ValueError("Missing native tldraw document snapshot")
        except (ValueError, TypeError, zlib.error, binascii.Error, RecursionError) as exc:
            raise StoreError("INVALID_CANVAS", "Canvas is not a valid native gzip/base64 snapshot") from exc

    @staticmethod
    def _metadata(payload, *, creating=False):
        fields = {}
        if creating or "projectName" in payload:
            name = payload.get("projectName", "Untitled")
            if not isinstance(name, str) or not name.strip() or len(name) > 200 or not _valid_text(name) or any(ord(c) < 32 for c in name):
                raise StoreError("INVALID_INPUT", "Project name must be 1–200 printable characters")
            fields["projectName"] = name
        for key, default in (("projectCoverList", []), ("picCount", 0), ("projectType", 3)):
            if not creating and key not in payload:
                continue
            value = payload.get(key, default)
            if key == "projectCoverList":
                if not isinstance(value, list) or len(value) > 20 or any(not isinstance(v, str) or len(v) > 4096 or not _valid_text(v) for v in value):
                    raise StoreError("INVALID_INPUT", "Project covers must be a bounded list of URLs")
                value = list(value)
            elif not _integer(value, 0, 1000000):
                raise StoreError("INVALID_INPUT", "Invalid " + key)
            fields[key] = value
        for key in ("isTitleChanged", "canvasV2Gray", "canvasEvidenceEnabled"):
            if key in payload:
                if not isinstance(payload[key], bool):
                    raise StoreError("INVALID_INPUT", "Invalid " + key)
                fields[key] = payload[key]
        return fields

    def _atomic_write(self, path, data):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="wb", prefix=".tmp-", dir=path.parent, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            temporary = None
        except OSError as exc:
            raise StoreError("STORE_IO", "Atomic local write failed; previous data was retained") from exc
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def _write_json(self, path, value):
        self._atomic_write(path, json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))

    def _read_json(self, path, limit):
        if not path.is_file():
            raise StoreError("NOT_FOUND", "Local item does not exist")
        try:
            with path.open("rb") as stream:
                data = stream.read(limit + 1)
            if len(data) > limit:
                raise ValueError("Stored item exceeds limit")
            result = json.loads(data.decode("utf-8"), parse_constant=_reject_constant, parse_float=_finite_float)
            if not isinstance(result, dict):
                raise ValueError("Stored item must be an object")
            return result
        except (ValueError, RecursionError) as exc:
            raise StoreError("CORRUPT_DATA", "Local item is corrupt") from exc

    def _read_project(self, project_id):
        project = self._read_json(self._path(self.projects_dir, project_id + ".json"), self.max_canvas_bytes + 512 * 1024)
        try:
            if project.get("projectId") != project_id or not isinstance(project.get("version"), str) or not project["version"]:
                raise StoreError("CORRUPT_DATA", "Project identity or version is corrupt")
            self._validate_canvas(project.get("canvas"), allow_empty=True)
            self._metadata(project, creating=True)
            if not _integer(project.get("createdAt"), 0, 10**16) or not _integer(project.get("updatedAt"), 0, 10**16):
                raise StoreError("CORRUPT_DATA", "Project timestamps are corrupt")
        except StoreError as exc:
            raise StoreError("CORRUPT_DATA", "Stored project failed validation") from exc
        return project

    def create_project(self, payload: dict) -> dict:
        self._payload(payload)
        project_id = self._project_id(payload.get("projectId", "local-" + uuid.uuid4().hex))
        canvas = payload.get("canvas", "")
        self._validate_canvas(canvas, allow_empty=True)
        fields = self._metadata(payload, creating=True)
        with self._locked():
            path = self._path(self.projects_dir, project_id + ".json")
            if path.exists():
                raise StoreError("ALREADY_EXISTS", "A project with this ID already exists")
            now = time.time_ns() // 1000000
            project = {**fields, "projectId": project_id, "canvas": canvas, "version": "local-" + uuid.uuid4().hex,
                       "createdAt": now, "updatedAt": now, "validProjectId": True,
                       "isTitleChanged": fields.get("isTitleChanged", False)}
            self._write_json(path, project)
            return project

    def get_project(self, project_id: str) -> dict:
        project_id = self._project_id(project_id)
        with self._locked():
            return self._read_project(project_id)

    def list_projects(self, page=1, page_size=20) -> dict:
        if not _integer(page, 1, 1000000) or not _integer(page_size, 1, 100):
            raise StoreError("INVALID_INPUT", "Invalid project pagination")
        with self._locked():
            self._check_directory(self.projects_dir)
            projects = []
            for path in self.projects_dir.glob("*.json"):
                project_id = self._project_id(path.stem)
                project = self._read_project(project_id)
                projects.append({key: value for key, value in project.items() if key != "canvas"})
            projects.sort(key=lambda project: (project["updatedAt"], project["projectId"]), reverse=True)
            start = (page - 1) * page_size
            return {"projects": projects[start:start + page_size], "page": page, "pageSize": page_size, "total": len(projects)}

    def save_project(self, payload: dict) -> dict:
        self._payload(payload)
        project_id = self._project_id(payload.get("projectId"))
        expected_version = payload.get("version")
        if not isinstance(expected_version, str) or not expected_version or len(expected_version) > 128:
            raise StoreError("INVALID_INPUT", "The version read from the project is required")
        canvas = payload.get("canvas")
        self._validate_canvas(canvas)
        fields = self._metadata(payload)
        with self._locked():
            current = self._read_project(project_id)
            if current["version"] != expected_version:
                raise StoreError("VERSION_CONFLICT", "Project changed since it was read; reload before saving")
            project = {**current, **fields, "canvas": canvas, "version": "local-" + uuid.uuid4().hex,
                       "updatedAt": max(time.time_ns() // 1000000, current["updatedAt"] + 1)}
            self._write_json(self._path(self.projects_dir, project_id + ".json"), project)
            return project

    @staticmethod
    def _asset_mime(data):
        if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24 and data[12:16] == b"IHDR":
            return "image/png"
        if data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9"):
            return "image/jpeg"
        if data.startswith((b"GIF87a", b"GIF89a")) and len(data) >= 13:
            return "image/gif"
        if len(data) >= 16 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
            return "image/webp"
        if len(data) >= 26 and data.startswith(b"BM"):
            return "image/bmp"
        if len(data) >= 16 and data[4:8] == b"ftyp" and any(data[i:i+4] in (b"avif", b"avis") for i in range(8, min(len(data), 64), 4)):
            return "image/avif"
        raise StoreError("INVALID_ASSET", "Only recognized PNG, JPEG, WebP, GIF, BMP or AVIF image bytes are supported")

    def put_asset(self, data: bytes, mime: str, filename="") -> dict:
        if not isinstance(data, bytes) or not data:
            raise StoreError("INVALID_ASSET", "Asset data must be nonempty bytes")
        if len(data) > self.max_asset_bytes:
            raise StoreError("ASSET_TOO_LARGE", "Asset exceeds the size limit")
        if not isinstance(mime, str) or mime.lower().strip() not in _MIMES:
            raise StoreError("INVALID_ASSET", "Unsupported asset MIME type")
        mime = mime.lower().strip()
        if self._asset_mime(data) != mime:
            raise StoreError("INVALID_ASSET", "Asset MIME type does not match its bytes")
        if not isinstance(filename, str) or len(filename) > 255 or not _valid_text(filename) or any(ord(c) < 32 for c in filename):
            raise StoreError("INVALID_INPUT", "Invalid asset display filename")
        # A user filename is display metadata only; it never enters a disk path.
        filename = filename.replace("\\", "/").rsplit("/", 1)[-1]
        digest = hashlib.sha256(data).hexdigest()
        with self._locked():
            path = self._path(self.assets_dir, digest)
            metadata_path = self._path(self.assets_dir, digest + ".json")
            if path.exists():
                if path.stat().st_size != len(data) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                    raise StoreError("CORRUPT_DATA", "Existing asset digest does not match its bytes")
            else:
                self._atomic_write(path, data)
            metadata = {"assetId": digest, "sha256": digest, "mime": mime, "size": len(data), "filename": filename}
            if metadata_path.exists():
                existing = self._read_json(metadata_path, 16384)
                if any(existing.get(key) != metadata[key] for key in ("assetId", "sha256", "mime", "size")):
                    raise StoreError("CORRUPT_DATA", "Existing asset metadata is inconsistent")
                return existing
            self._write_json(metadata_path, metadata)
            return metadata

    def get_asset(self, digest: str) -> tuple[Path, str]:
        if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
            raise StoreError("INVALID_ASSET_ID", "Asset ID must be a SHA-256 digest")
        with self._locked():
            path = self._path(self.assets_dir, digest)
            metadata = self._read_json(self._path(self.assets_dir, digest + ".json"), 16384)
            if not path.is_file():
                raise StoreError("NOT_FOUND", "Asset bytes do not exist")
            if path.stat().st_size > self.max_asset_bytes:
                raise StoreError("CORRUPT_DATA", "Stored asset exceeds the size limit")
            data = path.read_bytes()
            if metadata.get("assetId") != digest or metadata.get("sha256") != digest or metadata.get("size") != len(data) or hashlib.sha256(data).hexdigest() != digest:
                raise StoreError("CORRUPT_DATA", "Asset bytes or metadata failed digest verification")
            try:
                detected_mime = self._asset_mime(data)
            except StoreError as exc:
                raise StoreError("CORRUPT_DATA", "Stored asset failed type verification") from exc
            if metadata.get("mime") != detected_mime:
                raise StoreError("CORRUPT_DATA", "Stored asset MIME type is inconsistent")
            return path, detected_mime
