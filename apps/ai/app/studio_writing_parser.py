"""Bounded text extraction. Never render, execute, fetch links, OCR or call models."""
import base64
import io
import multiprocessing
import os
import posixpath
import re
import threading
import xml.etree.ElementTree as ET
import zipfile

from .studio_writing_schemas import StudioWritingParseRequest, StudioWritingParseResponse

REVISION = "studio-writing-text-v1"
MAX_BYTES, MAX_UNPACKED, MAX_TEXT, MAX_PAGES = 10*1024*1024, 32*1024*1024, 60000, 100
MIMES = {"txt": "text/plain", "md": "text/markdown", "pdf": "application/pdf",
         "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
         "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"}
_PARSER_CAPACITY = threading.BoundedSemaphore(2)


class WritingParseError(Exception):
    pass


def _require(value, code="invalid_document"):
    if not value:
        raise WritingParseError(code)


def _xml(data):
    _require(len(data) <= 8*1024*1024, "xml_too_large")
    # OOXML exports normally use UTF-8. Reject alternate encodings explicitly
    # rather than allowing a UTF-16 DTD to bypass the entity guard.
    try: source = data.decode("utf-8-sig")
    except UnicodeDecodeError: raise WritingParseError("xml_encoding_unsupported") from None
    _require("\x00" not in source, "xml_encoding_unsupported")
    _require(not re.search(r"<!\s*(DOCTYPE|ENTITY)", source, re.I), "xml_entities_forbidden")
    return ET.fromstring(source)


def _office(body, extension):
    _require(body.startswith(b"PK"))
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        entries = archive.infolist()
        _require(0 < len(entries) <= 2000, "archive_entry_limit")
        names = [entry.filename for entry in entries]
        _require(len(set(names)) == len(names), "duplicate_archive_entry")
        _require(sum(entry.file_size for entry in entries) <= MAX_UNPACKED, "archive_size_limit")
        for entry in entries:
            _require(not entry.flag_bits & 1, "encrypted_document")
            _require(not entry.filename.startswith(("/", "\\")) and ".." not in entry.filename.replace("\\", "/").split("/"), "unsafe_archive_path")
            _require(entry.file_size <= 8*1024*1024 and entry.file_size <= max(1, entry.compress_size)*200, "archive_ratio_limit")
            _require(not entry.filename.lower().endswith(("vbaproject.bin", ".exe", ".js")), "active_document_content")
        _require("[Content_Types].xml" in names)
        if extension == "docx":
            _require("word/document.xml" in names)
            root = _xml(archive.read("word/document.xml"))
            paragraphs = root.findall(".//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p")
            _require(len(paragraphs) <= 10000, "paragraph_limit")
            for number, paragraph in enumerate(paragraphs, 1):
                text = "".join(paragraph.itertext())
                yield text, None, f"段落 {number}（不推断排版页码）"
        else:
            _require("ppt/presentation.xml" in names and "ppt/_rels/presentation.xml.rels" in names)
            main = _xml(archive.read("ppt/presentation.xml"))
            rels = _xml(archive.read("ppt/_rels/presentation.xml.rels"))
            targets = {}
            for rel in rels:
                if rel.attrib.get("TargetMode") == "External": continue
                target = rel.attrib.get("Target", "")
                path = posixpath.normpath(posixpath.join("ppt", target))
                if path.startswith("ppt/slides/") and path.endswith(".xml"):
                    targets[rel.attrib.get("Id")] = path
            slides = main.findall(".//{http://schemas.openxmlformats.org/presentationml/2006/main}sldId")
            _require(0 < len(slides) <= MAX_PAGES, "page_limit")
            for number, slide in enumerate(slides, 1):
                key = slide.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
                path = targets.get(key)
                _require(path in names)
                root = _xml(archive.read(path))
                text = "\n".join(node.text or "" for node in root.findall(".//{http://schemas.openxmlformats.org/drawingml/2006/main}t"))
                yield text, number, f"幻灯片 {number}"


def extract_document(body, file_name, mime_type):
    """Pure extractor for fixtures; production calls it only in a bounded child."""
    _require(0 < len(body) <= MAX_BYTES, "file_size_limit")
    extension = file_name.rsplit(".", 1)[-1].lower()
    _require(extension in MIMES and mime_type == MIMES[extension], "unsupported_document")
    if extension in {"txt", "md"}:
        try: text = body.decode("utf-8-sig", errors="strict")
        except UnicodeDecodeError: raise WritingParseError("text_requires_utf8") from None
        _require("\x00" not in text, "invalid_text")
        pages = [(text, None, "文本片段")]
    elif extension == "pdf":
        from pypdf import PdfReader
        _require(body.startswith(b"%PDF-"))
        reader = PdfReader(io.BytesIO(body), strict=True)
        _require(not reader.is_encrypted, "encrypted_document")
        _require(0 < len(reader.pages) <= MAX_PAGES, "page_limit")
        pages = ((page.extract_text() or "", number, f"第 {number} 页") for number, page in enumerate(reader.pages, 1))
    else:
        pages = _office(body, extension)
    segments, total, truncated = [], 0, False
    for text, page, label in pages:
        text = text.replace("\x00", "").strip()
        if not text: continue
        # UTF-16 bounds match the public JavaScript contract including emoji.
        units = text.encode("utf-16-le")
        while units:
            if total >= MAX_TEXT or len(segments) >= 200:
                truncated = True
                break
            count = min(3000, MAX_TEXT-total)
            part = units[:count*2].decode("utf-16-le", errors="ignore")
            used = len(part.encode("utf-16-le"))//2
            if not used:
                truncated = True
                break
            units = units[used*2:]
            total += used
            segments.append({"id": f"segment-{len(segments)+1}", "pageNumber": page, "label": label, "text": part})
        if truncated: break
    _require(bool(segments), "no_extractable_text_no_ocr")
    return StudioWritingParseResponse(segments=segments, truncated=truncated, parserRevision=REVISION).model_dump()


def _child(pipe, body, file_name, mime_type):
    try:
        if os.name == "posix":
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (512*1024*1024, 512*1024*1024))
            resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
        result = extract_document(body, file_name, mime_type)
        pipe.send({"result": result})
    except WritingParseError as error:
        pipe.send({"error": str(error)})
    except Exception:
        pipe.send({"error": "invalid_document"})
    finally:
        pipe.close()


def parse_document(request: StudioWritingParseRequest):
    if not _PARSER_CAPACITY.acquire(blocking=False): raise WritingParseError("parse_busy")
    try:
        return _parse_in_child(request)
    finally:
        _PARSER_CAPACITY.release()


def _parse_in_child(request: StudioWritingParseRequest):
    try: body = base64.b64decode(request.contentBase64, validate=True)
    except Exception: raise WritingParseError("invalid_base64") from None
    _require(0 < len(body) <= MAX_BYTES, "file_size_limit")
    ctx = multiprocessing.get_context("spawn")
    parent, child = ctx.Pipe(duplex=False)
    process = ctx.Process(target=_child, args=(child, body, request.fileName, request.mimeType), daemon=True)
    try:
        process.start(); child.close()
        if not parent.poll(20): raise WritingParseError("parse_timeout")
        try: response = parent.recv()
        except EOFError: raise WritingParseError("parse_resource_limit") from None
        if "error" in response: raise WritingParseError(response["error"])
        return StudioWritingParseResponse.model_validate(response["result"])
    except WritingParseError:
        raise
    except Exception:
        raise WritingParseError("parse_unavailable") from None
    finally:
        parent.close(); child.close()
        if process.pid is not None:
            if process.is_alive(): process.terminate()
            process.join(timeout=2)
            if process.is_alive(): process.kill(); process.join(timeout=2)
