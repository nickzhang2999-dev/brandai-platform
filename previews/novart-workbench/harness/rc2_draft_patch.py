"""One bounded retry of a rejected draft GET, over the frozen M25 bridge."""
import hashlib

SOURCE_SHA256 = '1165c68b3439753653c122561afc1e612880ed74f9cac59d12c3c6bc62a441e9'
ANCHOR = b"""    try { response = await fetch('/studio/draft?projectId=' + encodeURIComponent(projectId),{cache:'no-store'}); }
    catch (_) { throw new Error('\xe8\x8d\x89\xe7\xa8\xbf\xe8\xaf\xbb\xe5\x8f\x96\xe8\xaf\xb7\xe6\xb1\x82\xe6\x9c\xaa\xe5\xae\x8c\xe6\x88\x90\xef\xbc\x8c\xe8\xaf\xb7\xe4\xbf\x9d\xe7\x95\x99\xe5\xbd\x93\xe5\x89\x8d\xe8\xbe\x93\xe5\x85\xa5\xe5\x90\x8e\xe9\x87\x8d\xe6\x96\xb0\xe8\xaf\xbb\xe5\x8f\x96\xe3\x80\x82'); }"""
REPLACEMENT = """    // Retry only a rejected read, once. HTTP and payload validation stay below.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (stopped) throw new Error('页面已关闭，原稿仍保留。');
      try {
        response = await fetch('/studio/draft?projectId=' + encodeURIComponent(projectId),{cache:'no-store'});
        break;
      } catch (_) {
        if (attempt === 1) throw new Error('草稿读取请求未完成，请保留当前输入后重新读取。');
        await new Promise(resolve => setTimeout(resolve,150));
      }
    }""".encode('utf-8')


def build_bridge(source):
    if not isinstance(source, bytes):
        raise TypeError('Expected frozen bridge bytes')
    if hashlib.sha256(source).hexdigest() != SOURCE_SHA256 or source.count(ANCHOR) != 1:
        raise ValueError('Frozen draft bridge or unique read anchor changed')
    derived = source.replace(ANCHOR, REPLACEMENT, 1)
    if derived.count(REPLACEMENT) != 1 or derived.replace(REPLACEMENT, ANCHOR, 1) != source:
        raise ValueError('Draft retry inverse validation failed')
    return derived
