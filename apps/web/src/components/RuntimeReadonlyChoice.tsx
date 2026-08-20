import { Cascader, Checkbox, Radio, Select } from "antd";
import type { SyntheticEvent } from "react";

type RuntimeReadonlyChoiceType = "select" | "cascader" | "radio" | "checkbox";

interface RuntimeReadonlyChoiceOption {
  value: string;
  label: string;
  children?: RuntimeReadonlyChoiceOption[];
}

interface RuntimeReadonlyChoiceProps {
  type: RuntimeReadonlyChoiceType;
  value: unknown;
  options: RuntimeReadonlyChoiceOption[];
  size?: "small" | "middle" | "large";
}

const preventReadonlyInteraction = (event: SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

export function RuntimeReadonlyChoice({ type, value, options, size = "middle" }: RuntimeReadonlyChoiceProps) {
  if (type === "select") {
    return <Select
      aria-readonly="true"
      className="runtime-readonly-choice"
      open={false}
      options={options}
      placeholder="未填写"
      size={size}
      tabIndex={-1}
      value={typeof value === "string" && value ? value : undefined}
      onKeyDown={preventReadonlyInteraction}
      onMouseDown={preventReadonlyInteraction}
    />;
  }

  if (type === "cascader") {
    return <Cascader
      aria-readonly="true"
      className="runtime-readonly-choice"
      open={false}
      options={options}
      placeholder="未填写"
      size={size}
      tabIndex={-1}
      value={Array.isArray(value) ? value as string[] : undefined}
      onKeyDown={preventReadonlyInteraction}
      onMouseDown={preventReadonlyInteraction}
    />;
  }

  if (type === "radio") {
    const selected = typeof value === "string" ? value : "";
    return <div className="runtime-readonly-choice runtime-readonly-options" role="radiogroup" aria-readonly="true">
      {options.length ? options.map((option) => (
        <Radio
          key={option.value}
          checked={selected === option.value}
          tabIndex={-1}
          value={option.value}
          onChange={() => undefined}
          onClick={preventReadonlyInteraction}
          onKeyDown={preventReadonlyInteraction}
        >
          {option.label}
        </Radio>
      )) : <span className="runtime-readonly-empty">未填写</span>}
    </div>;
  }

  const selected = new Set(Array.isArray(value) ? value.map(String) : []);
  return <div className="runtime-readonly-choice runtime-readonly-options" role="group" aria-readonly="true">
    {options.length ? options.map((option) => (
      <Checkbox
        key={option.value}
        checked={selected.has(option.value)}
        tabIndex={-1}
        value={option.value}
        onChange={() => undefined}
        onClick={preventReadonlyInteraction}
        onKeyDown={preventReadonlyInteraction}
      >
        {option.label}
      </Checkbox>
    )) : <span className="runtime-readonly-empty">未填写</span>}
  </div>;
}
