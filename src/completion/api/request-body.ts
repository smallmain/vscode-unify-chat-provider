export function omitRequestBodyFields(
  body: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, unknown> {
  const result = { ...body };
  for (const field of fields) {
    Reflect.deleteProperty(result, field);
  }
  return result;
}
