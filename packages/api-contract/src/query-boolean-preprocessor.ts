const booleanQueryParameterNames = ["activeOnly", "hasEmail", "includeDisabled"] as const;

const parseBooleanQueryValue = (value: unknown): unknown => {
  if (value === "true" || value === "1") {
    return true;
  }

  if (value === "false" || value === "0") {
    return false;
  }

  return value;
};

export const normalizeFlowPilotQueryBooleans = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const query = { ...value } as Record<string, unknown>;

  for (const parameterName of booleanQueryParameterNames) {
    if (Object.hasOwn(query, parameterName)) {
      query[parameterName] = parseBooleanQueryValue(query[parameterName]);
    }
  }

  return query;
};
