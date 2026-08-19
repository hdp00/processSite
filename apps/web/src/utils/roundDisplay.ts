export const formatRoundLabel = (round: number) => round > 1 ? `第 ${round} 轮` : "";

export const prefixWithRound = (round: number, text: string) => {
  const label = formatRoundLabel(round);
  return label ? `${label} · ${text}` : text;
};

export const formatRoundStartLabel = (round: number) => {
  const label = formatRoundLabel(round);
  return label ? `${label}发起` : "流程发起";
};
