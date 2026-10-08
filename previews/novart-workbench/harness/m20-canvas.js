/* M20: distinguish local write receipts from the unavailable remote WebSocket. */
(() => {
  'use strict';
  const query = new URLSearchParams(location.search);
  const expected = {ui:'novart', studio:'1', inputGuard:'m10', canvasTools:'m12', motion:'m13', feedback:'m14', visual:'m16', statusUi:'m20'};
  if (!Object.entries(expected).every(([key,value]) => query.getAll(key).length === 1 && query.get(key) === value)) return;
  if (location.hostname !== '127.0.0.1') return;

  function install() {
    const receipt = document.querySelector('#novart-bar .nv-save');
    const availability = document.getElementById('novart-availability');
    if (!receipt || !availability) return;
    availability.textContent = '本地编辑 · AI 与协作未接入';
    availability.title = '画布保存到这台电脑。AI 生成和在线协作暂不可用；保存结果请查看画布顶部记录。';
    availability.setAttribute('aria-label', availability.textContent + '。' + availability.title);
    receipt.setAttribute('role', 'status');
    receipt.setAttribute('aria-live', 'polite');
    receipt.setAttribute('aria-atomic', 'true');

    function describeReceipt() {
      const state = receipt.dataset.saveState || 'loading';
      const savedAt = Number(receipt.dataset.savedAt || 0);
      const last = savedAt ? '上次确认写入本机：' + new Date(savedAt).toLocaleTimeString('zh-CN', {hour12:false}) + '。' : '尚无已确认的画布保存记录。';
      const detail = state === 'error' ? '本次画布保存失败，请保留当前编辑窗口。' + last
        : state === 'unconfirmed' ? '暂时无法读取本机保存状态，请保留当前编辑窗口，等待重新确认。' + last
        : state === 'saved' ? '这里显示最近一次确认写入本机的时间，刚输入的编辑仍可能等待自动保存。'
        : state === 'empty' ? '画布还没有确认写入本机的内容，首次编辑后会自动保存。'
        : '正在读取本机保存状态。';
      receipt.title = detail + '需求和素材设置需要在各自面板中保存。';
      receipt.setAttribute('aria-label', receipt.textContent + '。' + receipt.title);
    }

    function clarifyOnlineNotice(root = document) {
      for (const toast of root.querySelectorAll('li[data-sonner-toast]')) {
        const title = toast.querySelector('[data-title] > p');
        const description = toast.querySelector('[data-description]');
        if (toast.dataset.nvOnlineNotice === 'm20' && (toast.dataset.type !== 'warning'
          || title?.textContent.trim() !== 'AI 服务未接入'
          || description?.textContent.trim() !== '可继续本地编辑，画布保存状态请看顶部。')) delete toast.dataset.nvOnlineNotice;
        // This exact pair is emitted only by the captured Agent WebSocket reconnect.
        // Save/version/upload errors and all other notices are left to the original UI.
        if (toast.dataset.type !== 'warning' || title?.textContent.trim() !== '网络不稳定'
          || description?.textContent.trim() !== '请检查网络或尝试刷新页面') continue;
        title.textContent = 'AI 服务未接入';
        description.textContent = '可继续本地编辑，画布保存状态请看顶部。';
        toast.dataset.nvOnlineNotice = 'm20';
      }
    }

    describeReceipt();
    clarifyOnlineNotice();
    const statusObserver = new MutationObserver(describeReceipt);
    statusObserver.observe(receipt, {childList:true, subtree:true, characterData:true,
      attributes:true, attributeFilter:['data-save-state','data-saved-at','data-error']});
    const noticeObserver = new MutationObserver(records => {
      if (records.some(record => !receipt.contains(record.target))) clarifyOnlineNotice();
    });
    noticeObserver.observe(document.body, {childList:true, subtree:true, characterData:true});
    window.addEventListener('pagehide', () => {statusObserver.disconnect(); noticeObserver.disconnect();}, {once:true});
  }
  // The inherited deferred M14 feedback script installs first. All deferred scripts
  // finish before DOMContentLoaded; this observer then owns the richer receipt text.
  if (document.readyState === 'complete') install();
  else document.addEventListener('DOMContentLoaded', install, {once:true});
})();
