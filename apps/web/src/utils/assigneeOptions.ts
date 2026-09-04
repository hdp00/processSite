export interface AssigneeSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export const includeSelectedAssigneeOption = (
  options: AssigneeSelectOption[],
  selectedId: string | undefined,
  selectedName: string | undefined,
  confirmedUnavailable: boolean,
) => {
  if (!selectedId || options.some((option) => option.value === selectedId)) return options;
  const name = selectedName?.trim() || "原审核人员";
  return [
    ...options,
    {
      value: selectedId,
      label: confirmedUnavailable ? `${name}（已失效，请重新选择）` : name,
      disabled: confirmedUnavailable,
    },
  ];
};

export const isSelectedAssigneeCandidate = (
  selectedId: string | undefined,
  remoteCandidates: Array<{ id: string }> | undefined,
  localCandidateIds: string[],
) => Boolean(selectedId && (remoteCandidates
  ? remoteCandidates.some((candidate) => candidate.id === selectedId)
  : localCandidateIds.includes(selectedId)));
