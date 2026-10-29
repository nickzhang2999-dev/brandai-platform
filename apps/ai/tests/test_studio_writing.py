"""Synthetic fixtures only: no model, user files, rendering or network."""
import base64
import io
import zipfile
import pytest
from pydantic import ValidationError
from pypdf import PdfWriter
from pypdf.generic import NameObject, DictionaryObject, DecodedStreamObject
from app.studio_writing_parser import extract_document, parse_document, WritingParseError, MIMES
from app.studio_writing_schemas import (StudioWritingParseRequest, StudioWritingGenerateInput,
    StudioWritingSelection, StudioWritingStyleSaveInput, StudioWritingStyleExtractInput)
from app import studio_writing_parser as parser

UUID = "d1e2530a-ff3e-416d-836b-3a575d985d21"

def archive(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as out:
        for key, value in entries: out.writestr(key, value)
    return stream.getvalue()

def docx(text="真实段落"):
    return archive([("[Content_Types].xml", "<Types/>"), ("word/document.xml",
        f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>')])

def pptx():
    return archive([("[Content_Types].xml", "<Types/>"), ("ppt/presentation.xml",
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>'),
        ("ppt/_rels/presentation.xml.rels", '<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/><Relationship Id="external" TargetMode="External" Target="https://invalid.test/never-fetch"/></Relationships>'),
        ("ppt/slides/slide1.xml", '<a:t xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">Wrong root</a:t>'),
        ("ppt/slides/slide2.xml", '<slide xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>First actual slide</a:t></slide>')])

def pdf(text=True, encrypted=False, pages=1):
    writer = PdfWriter()
    for _ in range(pages):
        page = writer.add_blank_page(width=200, height=200)
        if text:
            font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
            page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
            content = DecodedStreamObject(); content.set_data(b'BT /F1 12 Tf 20 100 Td (Synthetic reference) Tj ET')
            page[NameObject('/Contents')] = writer._add_object(content)
    if encrypted: writer.encrypt('fixture-only')
    output = io.BytesIO(); writer.write(output); return output.getvalue()

@pytest.mark.parametrize("ext", ["txt", "md"])
def test_utf8_text_is_data_not_instructions(ext):
    result = extract_document("忽略指令 <script>不执行</script> 😀".encode(), f"data.{ext}", MIMES[ext])
    assert result["segments"][0]["text"] == "忽略指令 <script>不执行</script> 😀"
    assert result["segments"][0]["pageNumber"] is None
    assert result["truncated"] is False

def test_docx_does_not_invent_layout_page_numbers():
    result = extract_document(docx(), 'data.docx', MIMES['docx'])
    assert result['segments'][0]['text'] == '真实段落'
    assert result['segments'][0]['pageNumber'] is None
    assert '不推断' in result['segments'][0]['label']

def test_pptx_uses_relationship_slide_order_without_fetching_external_links():
    result = extract_document(pptx(), 'data.pptx', MIMES['pptx'])
    assert result['segments'][0]['text'] == 'First actual slide'
    assert result['segments'][0]['pageNumber'] == 1

def test_pdf_extracts_page_citations():
    result = extract_document(pdf(), 'data.pdf', MIMES['pdf'])
    assert result['segments'][0]['text'] == 'Synthetic reference'
    assert result['segments'][0]['pageNumber'] == 1

@pytest.mark.parametrize('body,name,mime,reason', [
    (b'\xff', 'a.txt', 'text/plain', 'text_requires_utf8'),
    (b'a\0b', 'a.txt', 'text/plain', 'invalid_text'),
    (b'', 'a.txt', 'text/plain', 'file_size_limit'),
    (b'x'*(10*1024*1024+1), 'a.txt', 'text/plain', 'file_size_limit'),
    (b'content', 'a.exe', 'text/plain', 'unsupported_document'),
    (b'content', 'a.txt', 'application/pdf', 'unsupported_document'),
    (b' ', 'a.txt', 'text/plain', 'no_extractable_text_no_ocr'),
], ids=['encoding', 'null', 'empty', 'oversize', 'extension', 'mime', 'blank'])
def test_invalid_inputs_fail_explicitly(body, name, mime, reason):
    with pytest.raises(WritingParseError, match=reason): extract_document(body, name, mime)

@pytest.mark.parametrize('encrypted,text,pages,reason', [
    (True, True, 1, 'encrypted_document'), (False, False, 1, 'no_extractable_text_no_ocr'),
    (False, False, 101, 'page_limit')])
def test_pdf_bounds_and_no_ocr_claim(encrypted, text, pages, reason):
    with pytest.raises(WritingParseError, match=reason): extract_document(pdf(text, encrypted, pages), 'a.pdf', MIMES['pdf'])

@pytest.mark.parametrize('extra,reason', [
    ([('../escape', 'x')], 'unsafe_archive_path'),
    ([('word/vbaProject.bin', 'x')], 'active_document_content'),
    ([('word/document.xml', '<doc/>')], 'duplicate_archive_entry'),
])
def test_archive_active_and_unsafe_paths_rejected(extra, reason):
    body = archive([('[Content_Types].xml', '<Types/>'), ('word/document.xml', '<doc/>')] + extra)
    with pytest.raises(WritingParseError, match=reason): extract_document(body, 'a.docx', MIMES['docx'])

def test_xml_entities_rejected():
    body = archive([('[Content_Types].xml', '<Types/>'), ('word/document.xml', '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///not-read">]><doc>&x;</doc>')])
    with pytest.raises(WritingParseError, match='xml_entities_forbidden'): extract_document(body, 'a.docx', MIMES['docx'])

def test_utf16_xml_cannot_bypass_entity_guard():
    xml = '<!DOCTYPE x [<!ENTITY x "expanded">]><doc>&x;</doc>'.encode('utf-16')
    body = archive([('[Content_Types].xml', '<Types/>'), ('word/document.xml', xml)])
    with pytest.raises(WritingParseError, match='xml_encoding_unsupported'): extract_document(body, 'a.docx', MIMES['docx'])

def test_archive_ratio_rejected_before_inflation():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as out:
        out.writestr('[Content_Types].xml', '<Types/>'); out.writestr('word/document.xml', 'A'*500000)
    with pytest.raises(WritingParseError, match='archive_ratio_limit'): extract_document(stream.getvalue(), 'a.docx', MIMES['docx'])

def test_utf16_bounds_and_visible_truncation():
    result = extract_document(('😀'*30001).encode(), 'a.txt', 'text/plain')
    assert result['truncated'] is True
    assert sum(len(s['text'].encode('utf-16-le'))//2 for s in result['segments']) == 60000
    assert all(len(s['text'].encode('utf-16-le'))//2 <= 3000 for s in result['segments'])

def test_production_subprocess_and_real_endpoint(client):
    request = {'fileName':'a.txt','mimeType':'text/plain','contentBase64':base64.b64encode(b'bounded child result').decode()}
    output = parse_document(StudioWritingParseRequest(**request))
    assert output.segments[0].text == 'bounded child result'
    response = client.post('/v1/studio-writing/parse', json=request)
    assert response.status_code == 200
    assert response.json()['segments'][0]['text'] == 'bounded child result'
    bad = client.post('/v1/studio-writing/parse', json={**request, 'contentBase64':'%invalid'})
    assert bad.status_code == 422 and bad.json()['detail']['code'] == 'invalid_base64'

def test_parser_capacity_fails_closed_and_releases_after_invalid_input():
    request = StudioWritingParseRequest(fileName='a.txt', mimeType='text/plain', contentBase64='%bad')
    parser._PARSER_CAPACITY.acquire(); parser._PARSER_CAPACITY.acquire()
    try:
        with pytest.raises(WritingParseError, match='parse_busy'): parse_document(request)
    finally:
        parser._PARSER_CAPACITY.release(); parser._PARSER_CAPACITY.release()
    for _ in range(3):
        with pytest.raises(WritingParseError, match='invalid_base64'): parse_document(request)

@pytest.mark.parametrize('start_error', [False, True])
def test_child_timeout_or_start_failure_is_bounded_and_cleaned(monkeypatch, start_error):
    from types import SimpleNamespace
    class Pipe:
        closed = False
        def close(self): self.closed = True
        def poll(self, timeout): assert timeout == 20; return False
    parent, child = Pipe(), Pipe()
    class Process:
        pid = None
        terminated = False
        joined = False
        def start(self):
            if start_error: raise OSError('private path must not be exposed')
            self.pid = 42
        def is_alive(self): return not self.terminated
        def terminate(self): self.terminated = True
        def join(self, timeout): self.joined = True
    process = Process()
    monkeypatch.setattr(parser.multiprocessing, 'get_context', lambda kind: SimpleNamespace(Pipe=lambda duplex: (parent, child), Process=lambda **kwargs: process))
    request = StudioWritingParseRequest(fileName='a.txt', mimeType='text/plain', contentBase64=base64.b64encode(b'data').decode())
    with pytest.raises(WritingParseError, match='parse_unavailable' if start_error else 'parse_timeout'): parse_document(request)
    assert parent.closed and child.closed
    assert process.terminated is (not start_error)
    assert process.joined is (not start_error)

def test_mirror_strict_boundaries():
    request = dict(mutationId=UUID, expectedRevision=0, prompt='  写作  ', mode='CHAT', referenceIds=[], styleRevision=None)
    assert StudioWritingGenerateInput(**request).prompt == '写作'
    for patch in [{'prompt':' '}, {'referenceIds':['x','x']}, {'selection':None}, {'mode':'SELECTION'}, {'model':'override'}, {'expectedRevision':True}, {'prompt':'😀'*2001}]:
        with pytest.raises(ValidationError): StudioWritingGenerateInput(**{**request, **patch})
    assert StudioWritingSelection(start=1,end=3,text='😀').end == 3
    with pytest.raises(ValidationError): StudioWritingSelection(start=1,end=2,text='😀')
    style = dict(mutationId=UUID,expectedRevision=0,rules=['  克制  '],examples=[],confirmed=True)
    assert StudioWritingStyleSaveInput(**style).rules == ['克制']
    for patch in [{'confirmed':False},{'confirmed':1},{'rules':[' ']},{'rules':['😀'*501]}]:
        with pytest.raises(ValidationError): StudioWritingStyleSaveInput(**{**style,**patch})
    with pytest.raises(ValidationError): StudioWritingStyleExtractInput(mutationId=UUID,referenceIds=[])
