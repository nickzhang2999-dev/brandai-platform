import type { InspirationListResponse } from '@brandai/contracts';

type Channel = NonNullable<InspirationListResponse['syncStatus']>['content'];
const labels: Record<Channel['state'], string> = {
  disabled: '尚未开放', unconfigured: '尚未连接', unknown: '等待首次检查', healthy: '正常', stale: '需要检查', error: '暂未成功',
};
function time(value: string | null) { return value ? new Date(value).toLocaleString('zh-CN') : '暂无记录'; }

export default function InspirationSyncStatus({ data }: { data: InspirationListResponse }) {
  const status = data.syncStatus;
  if (!status) return <p className="mb-4 text-xs text-muted-foreground" role="status">
    {data.error ? '更新暂未完成，已有案例仍可浏览。' : '当前服务暂未提供独立同步检查记录。'}
  </p>;
  return <section aria-label="灵感库更新状态" className="mb-5 rounded-2xl border border-border bg-card px-4 py-3">
    <div className="flex flex-wrap gap-x-8 gap-y-3">
      <ChannelStatus title="内容更新" channel={status.content} />
      <ChannelStatus title="撤回检查" channel={status.withdrawals} />
    </div>
    {(status.content.state === 'error' || status.content.state === 'stale') && <p role="status" className="mt-3 text-xs leading-5 text-muted-foreground">{data.activeRelease ? '正在展示上次同步成功的案例，新内容可能尚未更新。' : '尚无可用案例，请等待同步完成。'}</p>}
    {(status.withdrawals.state === 'error' || status.withdrawals.state === 'stale') && <p role="status" className="mt-2 text-xs leading-5 text-destructive">最近的撤回检查未能确认。已知撤回仍生效，新的撤回可能尚未收到，请联系管理员检查连接。</p>}
    <details className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer text-primary">查看更新详情</summary>
      <dl className="mt-3 grid gap-2 break-all sm:grid-cols-[120px_minmax(0,1fr)]">
        <dt>当前版本</dt><dd>{data.activeRelease ? `${data.activeRelease.id} · 第 ${data.activeRelease.sequence} 版` : '尚无发布版本'}</dd>
        <dt>内容最近检查</dt><dd>{time(status.content.lastAttemptAt)}</dd>
        <dt>内容最近失败</dt><dd>{time(status.content.lastFailureAt)}</dd>
        <dt>撤回最近检查</dt><dd>{time(status.withdrawals.lastAttemptAt)}</dd>
        <dt>撤回最近失败</dt><dd>{time(status.withdrawals.lastFailureAt)}</dd>
        <dt>撤回序号</dt><dd>{data.withdrawalSequence}</dd>
        <dt>版本清单摘要</dt><dd>{status.activeManifestHash ?? '暂无可核验记录'}</dd>
        <dt>撤回清单摘要</dt><dd>{status.withdrawalHash ?? '暂无可核验记录'}</dd>
      </dl>
    </details>
  </section>;
}
function ChannelStatus({ title, channel }: { title: string; channel: Channel }) {
  return <div className="min-w-0 flex-1 basis-60">
    <div className="flex items-center gap-2 text-sm"><span className="font-medium">{title}</span><span className={`rounded-full px-2 py-0.5 text-xs ${channel.state === 'error' || channel.state === 'stale' ? 'bg-muted text-destructive' : 'bg-accent-soft text-primary'}`}>{labels[channel.state]}</span></div>
    <p className="mt-1 text-xs text-muted-foreground">最近成功：{time(channel.lastSuccessAt)}</p>
    {channel.error && <p className="mt-1 text-xs leading-5 text-destructive">{channel.error}</p>}
  </div>;
}
