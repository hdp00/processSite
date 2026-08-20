import { describe, expect, it } from "vitest";
import {
  createDesignerChoiceOption,
  displayDesignerChoiceValue,
  normalizeDesignerChoiceOptions,
  normalizeDesignerChoiceValue,
  updateDesignerChoiceOption,
} from "./designerOptions";

describe("designer choice options", () => {
  it("keeps a stable option id when its visible label is renamed", () => {
    const options = [createDesignerChoiceOption("A"), createDesignerChoiceOption("B")];
    const selectedId = options[0].id;
    const renamed = updateDesignerChoiceOption(options, selectedId, { label: "A1" });

    expect(renamed[0]).toMatchObject({ id: selectedId, label: "A1" });
    expect(displayDesignerChoiceValue(renamed, selectedId)).toBe("A1");
    expect(normalizeDesignerChoiceValue(renamed, "A1")).toBe(selectedId);
  });

  it("migrates legacy labels to deterministic ids", () => {
    const firstRead = normalizeDesignerChoiceOptions(["A", "B"], "field-choice");
    const secondRead = normalizeDesignerChoiceOptions(["A", "B"], "field-choice");

    expect(firstRead).toEqual(secondRead);
    expect(firstRead.every((option) => option.id.startsWith("option-"))).toBe(true);
  });

  it("preserves readable cascader paths while storing stable ids", () => {
    const options = normalizeDesignerChoiceOptions(["研发/软件", "研发/硬件"], "department", true);
    const value = normalizeDesignerChoiceValue(options, ["研发", "软件"], { hierarchical: true });

    expect(Array.isArray(value)).toBe(true);
    expect(displayDesignerChoiceValue(options, value, { hierarchical: true })).toBe("研发 / 软件");
  });

  it("omits removed options only for current-version list rendering", () => {
    const options = normalizeDesignerChoiceOptions(["A", "B"], "field-choice");

    expect(displayDesignerChoiceValue(options, [options[0].id, "removed-id"], { omitUnknown: true })).toBe("A");
    expect(displayDesignerChoiceValue(options, "removed-id", { omitUnknown: true })).toBe("");
    expect(displayDesignerChoiceValue(options, "removed-id")).toBe("removed-id");
  });
});
