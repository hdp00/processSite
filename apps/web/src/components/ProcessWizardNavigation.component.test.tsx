// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProcessWizardNextButton, ProcessWizardPreviousButton } from "./ProcessWizardNavigation";

describe("流程向导导航按钮", () => {
  it("将目标步骤写入可访问名称并触发对应操作", async () => {
    const previous = vi.fn();
    const next = vi.fn();
    const user = userEvent.setup();

    render(
      <>
        <ProcessWizardPreviousButton step="基本信息" onClick={previous} />
        <ProcessWizardNextButton step="流程设计" onClick={next} />
      </>,
    );

    await user.click(screen.getByRole("button", { name: /上一步：基本信息/ }));
    await user.click(screen.getByRole("button", { name: /下一步：流程设计/ }));

    expect(previous).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("透传禁用状态并阻止点击回调", async () => {
    const next = vi.fn();
    const user = userEvent.setup();

    render(<ProcessWizardNextButton step="发布" disabled onClick={next} />);
    const button = screen.getByRole("button", { name: /下一步：发布/ });

    expect(button).toBeDisabled();
    await user.click(button);
    expect(next).not.toHaveBeenCalled();
  });
});
