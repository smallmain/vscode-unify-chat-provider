const GEMINI_SCHEMA_FIELDS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'default',
  'items',
  'minItems',
  'maxItems',
  'enum',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minimum',
  'maximum',
  'pattern',
  'example',
  'anyOf',
  'propertyOrdering',
  'minLength',
  'maxLength',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fallbackObjectSchema(): Record<string, unknown> {
  return { type: 'object', properties: {} };
}

function cloneOpaqueValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneOpaqueValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  const cloned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    cloned[key] = cloneOpaqueValue(child);
  }
  return cloned;
}

function appendHintToDescription(
  target: Record<string, unknown>,
  hint: string,
): void {
  const trimmed = hint.trim();
  if (!trimmed) {
    return;
  }
  const existing = target['description'];
  if (typeof existing === 'string' && existing.trim()) {
    target['description'] = `${existing.trim()} (${trimmed})`;
    return;
  }
  target['description'] = trimmed;
}

function mergeGeminiSchemas(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  const incomingDescription = incoming['description'];
  if (
    typeof incomingDescription === 'string' &&
    incomingDescription.trim().length > 0
  ) {
    appendHintToDescription(merged, incomingDescription);
  }
  const incomingProperties = incoming['properties'];
  if (isRecord(incomingProperties)) {
    const baseProperties = merged['properties'];
    merged['properties'] = isRecord(baseProperties)
      ? { ...baseProperties, ...incomingProperties }
      : { ...incomingProperties };
  }
  const baseRequired = merged['required'];
  const incomingRequired = incoming['required'];
  if (Array.isArray(baseRequired) || Array.isArray(incomingRequired)) {
    const required = new Set<string>();
    for (const list of [baseRequired, incomingRequired]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (typeof item === 'string' && item.trim().length > 0) {
          required.add(item.trim());
        }
      }
    }
    merged['required'] = Array.from(required);
  }
  for (const [key, value] of Object.entries(incoming)) {
    if (
      key === 'description' ||
      key === 'properties' ||
      key === 'required' ||
      key in merged
    ) {
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function cleanGeminiSchemaNode(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const refValue = value['$ref'];
  if (typeof refValue === 'string' && refValue.trim().length > 0) {
    const idx = refValue.lastIndexOf('/');
    const defName = idx >= 0 ? refValue.slice(idx + 1) : refValue;
    const existingDescription =
      typeof value['description'] === 'string' ? value['description'] : '';
    return {
      type: 'object',
      description: existingDescription.trim()
        ? `${existingDescription.trim()} (See: ${defName})`
        : `See: ${defName}`,
    };
  }

  const allOf = value['allOf'];
  if (Array.isArray(allOf) && allOf.length > 0) {
    let merged: Record<string, unknown> = { ...value };
    delete merged['allOf'];
    for (const item of allOf) {
      if (!isRecord(item)) continue;
      merged = mergeGeminiSchemas(merged, cleanGeminiSchemaNode(item));
    }
    return cleanGeminiSchemaNode(merged);
  }

  const out: Record<string, unknown> = {};

  const oneOf = value['oneOf'];
  if (Array.isArray(oneOf)) {
    const variants = oneOf
      .filter(isRecord)
      .map((item) => cleanGeminiSchemaNode(item));
    if (variants.length > 0) {
      out['anyOf'] = variants;
    }
  }

  for (const [key, raw] of Object.entries(value)) {
    if (key === '$ref' || key === 'allOf' || key === 'oneOf') {
      continue;
    }
    if (key === 'enumDescriptions') {
      appendHintToDescription(out, 'enumDescriptions: removed');
      continue;
    }
    if (key === 'propertyNames') {
      appendHintToDescription(out, 'propertyNames: removed');
      continue;
    }
    if (key === 'const') {
      if (!Array.isArray(out['enum'])) {
        out['enum'] = [cloneOpaqueValue(raw)];
      }
      continue;
    }
    if (!GEMINI_SCHEMA_FIELDS.has(key)) {
      continue;
    }

    if (key === 'properties') {
      if (!isRecord(raw)) continue;
      const cleanedProperties: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(raw)) {
        cleanedProperties[propName] = isRecord(propSchema)
          ? cleanGeminiSchemaNode(propSchema)
          : fallbackObjectSchema();
      }
      out['properties'] = cleanedProperties;
      continue;
    }
    if (key === 'items') {
      if (Array.isArray(raw)) {
        out['items'] = raw.map((item) =>
          isRecord(item) ? cleanGeminiSchemaNode(item) : fallbackObjectSchema(),
        );
      } else {
        out['items'] = isRecord(raw)
          ? cleanGeminiSchemaNode(raw)
          : fallbackObjectSchema();
      }
      continue;
    }
    if (key === 'anyOf') {
      if (!Array.isArray(raw)) continue;
      out['anyOf'] = raw
        .filter(isRecord)
        .map((item) => cleanGeminiSchemaNode(item));
      continue;
    }
    if (key === 'enum' || key === 'example' || key === 'default') {
      out[key] = cloneOpaqueValue(raw);
      continue;
    }
    if (key === 'required') {
      if (Array.isArray(raw)) {
        out['required'] = raw.filter(
          (item): item is string =>
            typeof item === 'string' && item.trim().length > 0,
        );
      }
      continue;
    }
    out[key] = raw;
  }

  const typeRaw = out['type'];
  if (Array.isArray(typeRaw)) {
    const typeStrings = typeRaw
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    const nonNullTypes = typeStrings.filter((item) => item !== 'null');
    const hasNull = typeStrings.some((item) => item === 'null');
    delete out['type'];
    if (hasNull) {
      out['type'] = nonNullTypes[0] ?? 'string';
      out['nullable'] = true;
      if (nonNullTypes.length > 1) {
        appendHintToDescription(out, `Accepts: ${nonNullTypes.join(' | ')}`);
      }
    } else if (nonNullTypes.length > 1) {
      out['anyOf'] = nonNullTypes.map((item) => ({ type: item }));
    } else if (nonNullTypes.length === 1) {
      out['type'] = nonNullTypes[0];
    }
  }

  return Object.keys(out).length > 0 ? out : fallbackObjectSchema();
}

export function cleanJsonSchemaForGemini(
  schema: unknown,
): Record<string, unknown> {
  if (!isRecord(schema)) {
    return fallbackObjectSchema();
  }
  return cleanGeminiSchemaNode(schema);
}
