const periodText = (date: Date) => {
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}${month}`;
};

/** 仅用于配置页预览；正式编号由后端数据库计数器原子生成。 */
export const formatInstanceNumber = (prefix: string, sequence: number, date = new Date()) =>
  `${prefix.trim()}${periodText(date)}${String(sequence).padStart(4, "0")}`;
