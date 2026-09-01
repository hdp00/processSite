import { describe, expect, it } from "vitest";
import { resolveTaskCenterFlowLabel, taskCenterFlowSelectionUnavailable } from "./taskCenterFlowLabel";

describe("任务中心流程名称", () => {
  it("当前视图为空时保留用户刚才选择的流程名称", () => {
    expect(resolveTaskCenterFlowLabel("definition-id", {
      categories: [],
      definitions: [],
      instances: [],
      rememberedLabel: "PDF 文件审核",
    })).toBe("PDF 文件审核");
  });

  it("优先使用当前分类或流程定义中的正式名称", () => {
    expect(resolveTaskCenterFlowLabel("definition-id", {
      categories: [{ template: "definition-id", label: "当前分类名称" }],
      definitions: [{ id: "definition-id", name: "流程定义名称" }],
      rememberedLabel: "旧名称",
    })).toBe("当前分类名称");
  });

  it("任何名称都无法解析时不暴露内部 ID", () => {
    expect(resolveTaskCenterFlowLabel("8d76d91e-692f-4b84-916a-b51379146f38", {
      rememberedLabel: "8d76d91e-692f-4b84-916a-b51379146f38",
    })).toBe("未识别流程");
  });

  it("已选流程在新任务范围中不存在时暂停该筛选", () => {
    expect(taskCenterFlowSelectionUnavailable("flow-a", [])).toBe(true);
    expect(taskCenterFlowSelectionUnavailable("flow-a", [{ definitionId: "flow-b" }])).toBe(true);
    expect(taskCenterFlowSelectionUnavailable("flow-a", [{ definitionId: "flow-a" }])).toBe(false);
    expect(taskCenterFlowSelectionUnavailable(undefined, [])).toBe(false);
  });
});
