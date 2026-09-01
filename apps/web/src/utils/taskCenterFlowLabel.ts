interface FlowLabelCategory {
  template: string;
  label: string;
}

interface FlowLabelDefinition {
  id: string;
  name: string;
}

interface FlowLabelInstance {
  definitionId: string;
  template: string;
}

interface ResolveTaskCenterFlowLabelOptions {
  categories?: readonly FlowLabelCategory[];
  definitions?: readonly FlowLabelDefinition[];
  instances?: readonly FlowLabelInstance[];
  rememberedLabel?: string;
}

const readableLabel = (value: string | undefined, definitionId: string) => {
  const label = value?.trim();
  return label && label !== definitionId ? label : undefined;
};

export const resolveTaskCenterFlowLabel = (
  definitionId: string,
  options: ResolveTaskCenterFlowLabelOptions,
) => readableLabel(
  options.categories?.find((category) => category.template === definitionId)?.label,
  definitionId,
) ?? readableLabel(
  options.definitions?.find((definition) => definition.id === definitionId)?.name,
  definitionId,
) ?? readableLabel(
  options.instances?.find((instance) => instance.definitionId === definitionId)?.template,
  definitionId,
) ?? readableLabel(options.rememberedLabel, definitionId)
  ?? "未识别流程";

export const taskCenterFlowSelectionUnavailable = (
  selectedDefinitionId: string | undefined,
  categories: readonly { definitionId: string }[],
) => Boolean(selectedDefinitionId
  && !categories.some((category) => category.definitionId === selectedDefinitionId));
