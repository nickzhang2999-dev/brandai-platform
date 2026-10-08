/* The captured OSS client constructs HTTP URLs. Resolve those to the demo
   server before browser mixed-content checks, without changing native records. */
(() => {
  window.__NOVART_SHARED_DEMO__ = true;
  const localUpload = value => {
    try {
      const url = new URL(String(value), location.href);
      if (url.hostname === 'models-online-persist-us.oss-accelerate.aliyuncs.com')
        return '/share-resource?url=' + encodeURIComponent(url.href);
    } catch (_) {}
    return value;
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return open.call(this, method, localUpload(url), ...rest);
  };
})();
