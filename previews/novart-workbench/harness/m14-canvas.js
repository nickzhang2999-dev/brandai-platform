/* Clarify local-vs-online status without replacing the original save receipt. */
(() => {
  'use strict';
  const query = new URLSearchParams(location.search);
  if (query.get('feedback') !== 'm14' || query.get('studio') !== '1' || query.get('ui') !== 'novart') return;
  const availability = document.getElementById('novart-availability');
  const receipt = document.querySelector('#novart-bar .nv-save');
  if (!availability || !receipt) return;
  availability.textContent = 'AI 与协作未接入 · 支持本地编辑';
  availability.title = '线上服务提示不代表本地保存失败。画布是否写入请查看顶部记录；AI 和在线协作当前不可用。';
  availability.setAttribute('aria-label', availability.textContent + '。' + availability.title);
  const describe = () => {
    const failed = receipt.dataset.error === 'true';
    const detail = failed ? '请保留当前编辑窗口，确认本地预览服务仍在运行。此提示不代表保存成功。'
      : '仅表示最近一次确认写入本机的时间，不保证尚未发送的编辑已经保存。需求和素材设置需要各自保存。';
    receipt.title = detail;
    receipt.setAttribute('aria-label', receipt.textContent + '。' + detail);
  };
  describe();
  const observer = new MutationObserver(describe);
  observer.observe(receipt, {childList:true, subtree:true, attributes:true, attributeFilter:['data-error']});
  window.addEventListener('pagehide', () => observer.disconnect(), {once:true});
})();
