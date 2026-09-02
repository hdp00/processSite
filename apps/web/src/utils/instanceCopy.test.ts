import { describe, expect, it } from "vitest";
import type { StoredDesignerField } from "./designerStorage";
import { PROCESS_TITLE_FIELD_ID } from "./designerStorage";
import { buildCopiedAssigneeInitialValues, buildCopiedInstanceInitialValues } from "./instanceCopy";
import { createDesignerChoiceOption, displayDesignerChoiceValue, updateDesignerChoiceOption } from "./designerOptions";

const fields: StoredDesignerField[] = [
  { id: PROCESS_TITLE_FIELD_ID, label: "标题", type: "text", required: true },
  { id: "summary", label: "摘要", type: "text" },
  { id: "attachment", label: "附件", type: "attachment" },
  {
    id: "rows",
    label: "明细",
    type: "table",
    columns: [
      { id: "same", label: "兼容列", type: "text" },
      { id: "changed", label: "类型已变", type: "checkbox" },
      { id: "new", label: "新增列", type: "text", defaultValue: "默认值" },
    ],
  },
];

describe("buildCopiedInstanceInitialValues", () => {
  it("copies compatible content without attachments and fills target defaults", () => {
    const sourceFields: StoredDesignerField[] = [
      ...fields.slice(0, 3),
      {
        id: "rows",
        label: "旧明细",
        type: "table",
        columns: [
          { id: "same", label: "兼容列", type: "text" },
          { id: "changed", label: "旧类型", type: "text" },
        ],
      },
    ];
    const result = buildCopiedInstanceInitialValues(fields, sourceFields, {
      [PROCESS_TITLE_FIELD_ID]: "原标题",
      summary: "原摘要",
      attachment: [{ id: "file-1", name: "原附件.pdf" }],
      rows: [{ key: "old-row", same: "保留", changed: "不兼容" }],
    }, "原流程");

    expect(result[PROCESS_TITLE_FIELD_ID]).toBe("原流程（复制）");
    expect(result.summary).toBe("原摘要");
    expect(result.attachment).toEqual([]);
    expect(result.rows).toEqual([{ key: "copy-row-0", same: "保留", changed: [], new: "默认值" }]);
  });

  it("keeps renamed selections and drops options removed by the target version", () => {
    const optionA = createDesignerChoiceOption("A");
    const optionB = createDesignerChoiceOption("B");
    const optionC = createDesignerChoiceOption("C");
    const sourceFields: StoredDesignerField[] = [{
      id: "scope",
      label: "适用范围",
      type: "checkbox",
      options: [optionA, optionB, optionC],
    }];
    const targetOptions = updateDesignerChoiceOption([optionA, optionB], optionA.id, { label: "A1" });
    const targetFields: StoredDesignerField[] = [{
      ...sourceFields[0],
      options: targetOptions,
    }];

    const copied = buildCopiedInstanceInitialValues(
      targetFields,
      sourceFields,
      { scope: [optionA.id, optionC.id] },
      "原流程",
    );

    expect(copied.scope).toEqual([optionA.id]);
    expect(displayDesignerChoiceValue(targetOptions, copied.scope)).toBe("A1");
  });
});

describe("buildCopiedAssigneeInitialValues", () => {
  it("copies only assignees who remain valid for the corresponding target node", () => {
    const copied = buildCopiedAssigneeInitialValues(
      [
        { id: "review-a", specifyAssignee: true },
        { id: "review-b", specifyAssignee: true },
        { id: "shared", specifyAssignee: false },
      ],
      [
        { nodeId: "review-a", round: 1, defaultAssigneeId: "old-a" },
        { nodeId: "review-a", round: 2, defaultAssigneeId: "user-a" },
        { nodeId: "review-b", round: 2, defaultAssigneeId: "removed-user" },
      ],
      2,
      {
        "review-a": ["user-a", "user-b"],
        "review-b": ["user-b"],
      },
    );

    expect(copied).toEqual({ "reviewer-review-a": "user-a" });
  });
});
