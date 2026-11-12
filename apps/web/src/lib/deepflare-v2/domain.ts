import {
  DeepFlareV2Brief, DeepFlareV2Command, DeepFlareV2State,
  type DeepFlareV2Task,
} from "@brandai/contracts";

export class WorkOrderConflict extends Error {}

/** One explicit recipe; this is deterministic orchestration, not an LLM planner. */
export function planTasks(brief: DeepFlareV2Brief): DeepFlareV2Task[] {
  const primary = brief.deliverables[0];
  if (!primary) throw new WorkOrderConflict("至少需要一个交付物");
  const tasks: DeepFlareV2Task[] = [
    { id: "inspiration", role: "INSPIRATION", dependsOn: [], memoryKinds: ["INSPIRATION"], deliverableId: null },
    { id: "copy", role: "COPYWRITING", dependsOn: ["inspiration"], memoryKinds: ["COPY", "FEEDBACK"], deliverableId: null },
    { id: "visual", role: "VISUAL", dependsOn: ["inspiration"], memoryKinds: ["VISUAL", "FEEDBACK"], deliverableId: primary.id },
    ...brief.deliverables.slice(1).map((item, index): DeepFlareV2Task => ({
      id: `adapt_${index + 1}`, role: "ADAPTATION", dependsOn: ["copy", "visual"],
      memoryKinds: ["VISUAL", "FEEDBACK"], deliverableId: item.id,
    })),
  ];
  tasks.push({ id: "qa", role: "QA", dependsOn: tasks.filter(task => task.id !== "inspiration").map(task => task.id),
    memoryKinds: ["FEEDBACK"], deliverableId: null });
  return tasks;
}

export function initialState(raw: unknown): DeepFlareV2State {
  const brief = DeepFlareV2Brief.parse(raw);
  return DeepFlareV2State.parse({ protocolVersion: 1, revision: 1, planVersion: 1, status: "DRAFT",
    brief, direction: null, approvedPlanVersion: null, revisionReason: null, tasks: planTasks(brief) });
}

/** Revision CAS and idempotent retries are enforced by the transactional repository. */
export function transition(state: DeepFlareV2State, raw: unknown): DeepFlareV2State {
  const current = DeepFlareV2State.parse(state);
  const command = DeepFlareV2Command.parse(raw);
  const next = structuredClone(current);
  const editable = ["DRAFT", "AWAITING_DIRECTION", "REVISION_REQUESTED"].includes(current.status);
  const requireState = (condition: boolean, message: string) => {
    if (!condition) throw new WorkOrderConflict(message);
  };
  switch (command.type) {
    case "SET_DIRECTION":
      requireState(editable && current.brief.mode === "DIRECTION_FIRST", "当前工作单不能修改方向");
      next.direction = command.direction;
      next.planVersion++;
      next.status = "DRAFT";
      next.approvedPlanVersion = null;
      break;
    case "REVISE_BRIEF":
      requireState(editable, "已交给执行器的工作单不能改写，请另建工作单");
      next.brief = command.brief;
      next.tasks = planTasks(command.brief);
      next.direction = null;
      next.planVersion++;
      next.approvedPlanVersion = null;
      next.status = "DRAFT";
      break;
    case "SUBMIT":
      requireState(current.status === "DRAFT", "请先完成新版需求或方向再提交");
      if (current.brief.mode === "DIRECTION_FIRST") {
        requireState(current.direction !== null, "请先准备创意方向");
        next.status = "AWAITING_DIRECTION";
      } else {
        next.status = "READY";
        next.approvedPlanVersion = current.planVersion;
      }
      break;
    case "CONFIRM_DIRECTION":
      requireState(current.status === "AWAITING_DIRECTION" && current.direction !== null, "没有等待确认的创意方向");
      requireState(command.planVersion === current.planVersion, "创意方向已更新，请确认最新版本");
      next.status = "READY";
      next.approvedPlanVersion = current.planVersion;
      break;
    case "REQUEST_REVISION":
      requireState(current.status === "AWAITING_DIRECTION", "当前工作单不在方向审核阶段");
      next.status = "REVISION_REQUESTED";
      next.revisionReason = command.reason;
      next.approvedPlanVersion = null;
      break;
    case "CANCEL":
      requireState(editable, "当前工作单不能取消；已提交任务的撤销由执行器负责");
      next.status = "CANCELLED";
      break;
  }
  next.revision++;
  return DeepFlareV2State.parse(next);
}
