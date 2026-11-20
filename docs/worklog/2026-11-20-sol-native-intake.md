# DF-2 Sol 工作单接入 Studio

后续实测补齐真实 Redis 入队与迁移隔离检查。线上分支预览当前仍与 main 指向同一数据库和 schema，待确定预览数据范围后切换。[预览核对与队列验收](../deepflare-2.0/logs/2026-11-20-sol-preview-isolation.md)

本批在 `df-2-sol` 实现确认方向后的首张主视觉派发，复用普通画布生图的权限、额度和任务记录。独立数据库验证了普通请求与 Sol 并发、中断回滚与单请求恢复。真实图片和费用列入试点验收。[开发日志与验证结果](../deepflare-2.0/logs/2026-11-20-sol-native-intake.md)
