import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_LIST_FIELDS } from "../data/listFieldConfig";
import {
  captureWorkingDesignerSnapshot,
  clearDefinitionDesignerArtifacts,
  createProcessTitleField,
  getReviewEditableFieldOptions,
  readFlowDesignerSnapshot,
  readFormDesignerSnapshot,
  writeWorkingDesignerSnapshot,
} from "./designerStorage";

describe("设计器存储的无浏览器环境回退", () => {
  it("does not access browser storage during server-side evaluation", () => {
    expect(typeof window).toBe("undefined");
    expect(readFormDesignerSnapshot("server-render")).toBeUndefined();
    expect(readFlowDesignerSnapshot("server-render")).toBeUndefined();
    expect(getReviewEditableFieldOptions("server-render")).toEqual([]);
    expect(() => clearDefinitionDesignerArtifacts("server-render")).not.toThrow();
  });

  it("returns explicit write failure and complete defaults without window", () => {
    const source = {
      form: { fields: [createProcessTitleField()] },
      flow: { nodes: [], edges: [] },
      systemFields: DEFAULT_SYSTEM_LIST_FIELDS,
    };

    expect(writeWorkingDesignerSnapshot("server-render", source)).toBe(false);
    expect(captureWorkingDesignerSnapshot("server-render")).toEqual({
      form: { fields: [createProcessTitleField()] },
      flow: { nodes: [], edges: [], meta: { rejectionHandling: "resubmit-or-close" } },
      systemFields: DEFAULT_SYSTEM_LIST_FIELDS,
    });
  });
});
