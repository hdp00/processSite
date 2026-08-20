import { createClientUuid } from "./clientId";

export interface DesignerChoiceOption {
  id: string;
  label: string;
  children?: DesignerChoiceOption[];
}

interface AntChoiceOption {
  value: string;
  label: string;
  children?: AntChoiceOption[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const stableHash = (value: string) => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const stableOptionId = (scope: string, path: string) => `option-${stableHash(`${scope}:${path}`)}`;

export const createDesignerChoiceOption = (label: string): DesignerChoiceOption => ({
  id: `option-${createClientUuid()}`,
  label,
});

const normalizeObjectOptions = (source: unknown[], scope: string, parentPath = ""): DesignerChoiceOption[] =>
  source.flatMap((raw, index) => {
    if (typeof raw === "string") {
      const label = raw.trim();
      if (!label) return [];
      const path = parentPath ? `${parentPath}/${label}` : label;
      return [{ id: stableOptionId(scope, path), label }];
    }
    if (!isRecord(raw)) return [];
    const label = String(raw.label ?? raw.name ?? raw.value ?? "").trim();
    if (!label) return [];
    const path = parentPath ? `${parentPath}/${label}` : label;
    const children = Array.isArray(raw.children)
      ? normalizeObjectOptions(raw.children, scope, path)
      : undefined;
    return [{
      id: typeof raw.id === "string" && raw.id ? raw.id : stableOptionId(scope, `${path}:${index}`),
      label,
      ...(children?.length ? { children } : {}),
    }];
  });

const legacyPathsToTree = (paths: string[], scope: string): DesignerChoiceOption[] => {
  const roots: DesignerChoiceOption[] = [];
  paths.forEach((rawPath) => {
    const labels = rawPath.split("/").map((item) => item.trim()).filter(Boolean);
    let siblings = roots;
    const path: string[] = [];
    labels.forEach((label) => {
      path.push(label);
      let option = siblings.find((item) => item.label === label);
      if (!option) {
        option = { id: stableOptionId(scope, path.join("/")), label };
        siblings.push(option);
      }
      option.children ??= [];
      siblings = option.children;
    });
  });
  const prune = (options: DesignerChoiceOption[]): DesignerChoiceOption[] => options.map((option) => ({
    ...option,
    ...(option.children?.length ? { children: prune(option.children) } : { children: undefined }),
  }));
  return prune(roots);
};

export const normalizeDesignerChoiceOptions = (
  value: unknown,
  scope: string,
  hierarchical = false,
): DesignerChoiceOption[] => {
  if (!Array.isArray(value)) return [];
  if (hierarchical && value.every((item) => typeof item === "string")) {
    return legacyPathsToTree(value as string[], scope);
  }
  return normalizeObjectOptions(value, scope);
};

export const designerChoiceOptionsToAntd = (options?: DesignerChoiceOption[]): AntChoiceOption[] =>
  (options ?? []).map((option) => ({
    value: option.id,
    label: option.label,
    ...(option.children?.length ? { children: designerChoiceOptionsToAntd(option.children) } : {}),
  }));

export const flattenDesignerChoiceOptions = (options?: DesignerChoiceOption[]): DesignerChoiceOption[] =>
  (options ?? []).flatMap((option) => [option, ...flattenDesignerChoiceOptions(option.children)]);

export const designerChoiceOptionPaths = (options?: DesignerChoiceOption[]) => {
  const paths: string[] = [];
  const visit = (items: DesignerChoiceOption[], parents: string[]) => items.forEach((option) => {
    const path = [...parents, option.label];
    if (option.children?.length) visit(option.children, path);
    else paths.push(path.join("/"));
  });
  visit(options ?? [], []);
  return paths;
};

const matchOption = (options: DesignerChoiceOption[], value: string) =>
  options.find((option) => option.id === value || option.label === value);

export const normalizeDesignerChoiceValue = (
  options: DesignerChoiceOption[] | undefined,
  value: unknown,
  settings: { hierarchical?: boolean; multiple?: boolean } = {},
): unknown => {
  const source = options ?? [];
  if (settings.hierarchical) {
    if (!Array.isArray(value)) return value;
    let siblings = source;
    return value.map(String).map((part) => {
      const option = matchOption(siblings, part);
      siblings = option?.children ?? [];
      return option?.id ?? part;
    });
  }
  const resolve = (part: unknown) => {
    const text = String(part ?? "");
    return matchOption(source, text)?.id ?? text;
  };
  if (settings.multiple) return Array.isArray(value) ? value.map(resolve) : [];
  return Array.isArray(value) ? value.map(resolve) : resolve(value);
};

export const displayDesignerChoiceValue = (
  options: DesignerChoiceOption[] | undefined,
  value: unknown,
  settings: { hierarchical?: boolean; separator?: string; omitUnknown?: boolean } = {},
) => {
  const source = options ?? [];
  if (settings.hierarchical && Array.isArray(value)) {
    let siblings = source;
    const labels = value.map(String).map((part) => {
      const option = matchOption(siblings, part);
      siblings = option?.children ?? [];
      return option?.label ?? (settings.omitUnknown ? "" : part);
    });
    return settings.omitUnknown && labels.some((label) => !label)
      ? ""
      : labels.join(settings.separator ?? " / ");
  }
  const flat = flattenDesignerChoiceOptions(source);
  const resolve = (part: unknown) => {
    const text = String(part ?? "");
    return flat.find((option) => option.id === text || option.label === text)?.label ?? (settings.omitUnknown ? "" : text);
  };
  return Array.isArray(value) ? value.map(resolve).filter(Boolean).join(settings.separator ?? "、") : resolve(value);
};

export const updateDesignerChoiceOption = (
  options: DesignerChoiceOption[],
  optionId: string,
  patch: Partial<Pick<DesignerChoiceOption, "label" | "children">>,
): DesignerChoiceOption[] => options.map((option) => option.id === optionId
  ? { ...option, ...patch }
  : { ...option, ...(option.children ? { children: updateDesignerChoiceOption(option.children, optionId, patch) } : {}) });

export const removeDesignerChoiceOption = (options: DesignerChoiceOption[], optionId: string): DesignerChoiceOption[] =>
  options.filter((option) => option.id !== optionId).map((option) => ({
    ...option,
    ...(option.children ? { children: removeDesignerChoiceOption(option.children, optionId) } : {}),
  }));

export const appendDesignerChoiceOption = (
  options: DesignerChoiceOption[],
  label: string,
  parentId?: string,
): DesignerChoiceOption[] => {
  const created = createDesignerChoiceOption(label);
  if (!parentId) return [...options, created];
  return options.map((option) => option.id === parentId
    ? { ...option, children: [...(option.children ?? []), created] }
    : { ...option, ...(option.children ? { children: appendDesignerChoiceOption(option.children, label, parentId) } : {}) });
};
