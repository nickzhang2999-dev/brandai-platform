# 品牌删除后端集成用例合同修复

日期：2026-10-31。分支：`claude/layer-quality`。归因：O（集成用例仍沿用旧请求合同）。

Branch Image `41208816669` 在 `verify-studio-brands-backend.ts` 的创建墓碑重放检查失败：旧用例直接发送无正文的 `DELETE /api/workspaces/:id` 并期待 200；生产删除接口已要求 JSON 确认正文，因此正确返回 415。本次仅更新测试脚本，不放宽生产删除接口。

用例现在保留无正文 DELETE 的拒绝断言，确认品牌仍存在；随后调用真实删除预览，核对品牌 ID、完整名称、影响计数、无活动任务与确认指纹，再提交 `confirmationName`、`confirmationToken`、新的 `mutationId` 和操作人头。成功后重放同一删除请求，核对回执一致；原来的创建回执墓碑及创建重放返回 410 的断言全部保留。

只读搜索了其他真实 backend fixture：没有第二处旧的 workspace DELETE；规则、禁用项等子资源删除使用自己的合同，未改动。

本地验证：

- 全新、仅监听 127.0.0.1 的隔离 PostgreSQL 集群，53 条迁移从零成功。目录位于本机 `.novart-tmp/brand-fixture-contract-20261031`。
- 直接运行修改后的 `verifyStudioBrandsBackend` 函数，调用实际生产 route handler 和隔离 `novart_integration_test` 数据库，17 项检查全部通过。认证提供方和 cookie 请求上下文使用合成夹具，不声明已完成 HTTP/Auth.js 链路验收；禁止所有外部 fetch，没有模型调用。
- 实际 PostgreSQL 删除隔离与并发回归 12/12；删除 route/client 回归 20/20；web typecheck 通过。
- 测试结束后两个隔离库的 User、BrandWorkspace、BrandDeletionReceipt 均为 0；删除回归库 AsyncTask、StudioDecompositionRequest 也为 0。原有测试集群未清除，新测试集群已停止，55438/3317 无监听。未接触真实客户数据库或删除真实品牌。

本机尝试启动 loopback Next 服务时，自动审批系统拒绝了该启动命令，只返回 `blocked by policy`，未提供更细原因。未重试或绕过该操作，改用上述生产 handler＋隔离数据库验证。完整 HTTP/Auth.js 链路仍由下一次正常 CI 验证；本地没有把这一层标记为通过。

临时夹具 runner 与隔离数据库保留于私有测试辅助目录，未加入产品源码。没有修改模型、服务配置、生产代码或发布门禁。
