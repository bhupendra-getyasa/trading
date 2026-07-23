'use strict';
/*
 * registry.js — the tool registry and its argument validator.
 *
 * WHY NO ZOD: this repo has no validation library (package-lock has no
 * joi/zod/yup/ajv, and validation/auth.validation.js is an empty file); it
 * hand-rolls its parsers throughout (see live-engine/lib/util.js). Adding zod
 * would also create the dual-schema problem — zod's .refine() is invisible to
 * JSON Schema, so the model never sees the constraint and burns a round-trip
 * discovering it. With five tools taking simple args, writing the JSON Schema
 * literally (which is what Anthropic's `input_schema` wants anyway) and
 * validating against that same object means there is exactly ONE schema and the
 * model sees all of it.
 *
 * A tool is:
 *   { name, version, description, input_schema, execute(args, ctx) }
 *
 * `description` is PROMPT, not documentation. It is the only thing the model
 * reads when choosing a tool, so it is written contrastively — each one says
 * what it is NOT for and names the alternative. Overlapping descriptions are
 * the #1 cause of wrong-tool selection, and that fails silently: the model gets
 * a valid result with the wrong fields and answers from what it has.
 */

const FORBIDDEN_ARG_KEYS = ['userid', 'user_id', 'user', 'account_id', 'accountid'];

const tools = new Map();
let frozen = false;

function assertNoForbiddenKeys(name, schema, path = '') {
  if (!schema || typeof schema !== 'object') return;
  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      if (FORBIDDEN_ARG_KEYS.includes(key.toLowerCase())) {
        throw new Error(
          `tool "${name}" declares a forbidden argument "${path}${key}". ` +
            'Identity is never a model-supplied argument. If a tool ever needs it, ' +
            'it must come from the server-side context, not from the model.'
        );
      }
      assertNoForbiddenKeys(name, schema.properties[key], `${path}${key}.`);
    }
  }
  if (schema.items) assertNoForbiddenKeys(name, schema.items, `${path}[].`);
}

function register(def) {
  if (frozen) throw new Error('tool registry is frozen; register at boot only');
  if (!def || !def.name) throw new Error('tool definition requires a name');
  if (tools.has(def.name)) throw new Error(`duplicate tool name: ${def.name}`);
  if (!def.description || def.description.length < 20) {
    throw new Error(`tool "${def.name}" needs a real description — the model reads it to choose`);
  }
  if (!def.input_schema || def.input_schema.type !== 'object') {
    throw new Error(`tool "${def.name}" needs an object input_schema`);
  }
  if (typeof def.execute !== 'function') throw new Error(`tool "${def.name}" needs execute()`);
  assertNoForbiddenKeys(def.name, def.input_schema);
  tools.set(def.name, def);
}

function freeze() {
  frozen = true;
}

function get(name) {
  return tools.get(name);
}

function list() {
  return [...tools.values()];
}

/** The array handed to the Anthropic Messages API `tools` parameter. */
function toModelSpecs() {
  return list().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/**
 * Validate model-supplied args against a tool's input_schema.
 *
 * Returns { ok: true, value } or { ok: false, errors: [...] }. The errors are
 * handed back to the model so it can self-correct on the next iteration — the
 * Messages API has no strict-mode equivalent, so malformed args are a normal
 * occurrence rather than an exception.
 */
function validate(schema, args) {
  const errors = [];
  const out = {};
  const input = args && typeof args === 'object' ? args : {};
  const props = schema.properties || {};
  const required = schema.required || [];

  for (const key of Object.keys(input)) {
    if (!props[key]) errors.push(`unknown argument "${key}"`);
  }

  for (const key of required) {
    if (input[key] === undefined || input[key] === null || input[key] === '') {
      errors.push(`missing required argument "${key}"`);
    }
  }

  for (const [key, spec] of Object.entries(props)) {
    const v = input[key];
    if (v === undefined || v === null) {
      if (spec.default !== undefined) out[key] = spec.default;
      continue;
    }
    const err = checkValue(key, spec, v);
    if (err) errors.push(err);
    else out[key] = coerce(spec, v);
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

function checkValue(key, spec, v) {
  if (spec.enum && !spec.enum.includes(v)) {
    return `"${key}" must be one of: ${spec.enum.join(', ')} (got "${v}")`;
  }
  if (spec.type === 'string') {
    if (typeof v !== 'string') return `"${key}" must be a string`;
    if (spec.pattern && !new RegExp(spec.pattern).test(v)) {
      return `"${key}" must match ${spec.pattern} (got "${v}")`;
    }
  }
  if (spec.type === 'integer' || spec.type === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) return `"${key}" must be a number`;
    if (spec.type === 'integer' && !Number.isInteger(n)) return `"${key}" must be an integer`;
    if (spec.minimum != null && n < spec.minimum) return `"${key}" must be >= ${spec.minimum}`;
    if (spec.maximum != null && n > spec.maximum) return `"${key}" must be <= ${spec.maximum}`;
  }
  if (spec.type === 'array') {
    if (!Array.isArray(v)) return `"${key}" must be an array`;
    if (spec.minItems != null && v.length < spec.minItems) return `"${key}" needs at least ${spec.minItems} items`;
    if (spec.maxItems != null && v.length > spec.maxItems) return `"${key}" allows at most ${spec.maxItems} items`;
    for (const item of v) {
      const e = checkValue(`${key}[]`, spec.items || {}, item);
      if (e) return e;
    }
  }
  return null;
}

function coerce(spec, v) {
  if (spec.type === 'integer') return parseInt(v, 10);
  if (spec.type === 'number') return Number(v);
  return v;
}

module.exports = { register, freeze, get, list, toModelSpecs, validate, FORBIDDEN_ARG_KEYS };
