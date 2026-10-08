"""Preserve original reference metadata when the native image preview updates."""
import hashlib

SOURCE_SHA256 = '3490181629b0d2844c99422b5f43a3f6a184fe012c8e6384a9ae36870e76ca2a'
ANCHOR = b'data:null!=i?{imageUrl:i.url,imageWidth:i.w,imageHeight:i.h}:null==(n=e.data)||null==(r=n.param)?void 0:r.data'
REPLACEMENT = b'data:null!=i?{...e.data?.param?.data,imageUrl:i.url,imageWidth:i.w,imageHeight:i.h}:null==(n=e.data)||null==(r=n.param)?void 0:r.data'


def build_native(source):
    if not isinstance(source, bytes):
        raise TypeError('Expected frozen native bytes')
    if hashlib.sha256(source).hexdigest() != SOURCE_SHA256 or source.count(ANCHOR) != 1:
        raise ValueError('Native source or unique reference-update anchor changed')
    derived = source.replace(ANCHOR, REPLACEMENT, 1)
    if derived.count(REPLACEMENT) != 1 or derived.replace(REPLACEMENT, ANCHOR, 1) != source:
        raise ValueError('Reference metadata inverse check failed')
    return derived
