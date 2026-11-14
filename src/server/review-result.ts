/**
 * What a Review's model must answer (ADR 0009): one call of the tool `report_observations`, whose arguments are
 * the result. The arguments come from the model, so they are checked strictly here; anything that does not fit
 * makes the Review fail with a reason, and nothing from a wrong answer is kept.
 */

import { isRecord } from "./json-file.js";

export const REPORT_TOOL = "report_observations";

export const LEVELS = ["info", "notable", "urgent"] as const;
export type Level = (typeof LEVELS)[number];

/** One piece of evidence, as structured fields. Every field is optional, but an item says at least one thing. */
export interface Evidence {
  client?: string;
  path?: string;
  status?: number;
  count?: number;
  /** A period in words or timestamps, as the model wrote it. */
  period?: string;
}

export interface Observation {
  level: Level;
  /** Host names of the Sites involved. */
  sites: string[];
  title: string;
  explanation: string;
  evidence: Evidence[];
  /** True when it is the same thing continuing from the previous Review. Absent in Reviews stored before it existed. */
  ongoing?: boolean;
}

export interface ReviewResult {
  summary: string;
  observations: Observation[];
}

const LIMITS = { summary: 500, title: 200, explanation: 2000, host: 253, sites: 50, evidence: 20, observations: 50, client: 100, path: 500, period: 100 };

/** The JSON Schema of the tool's arguments, which the model is given. */
export const RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "observations"],
  properties: {
    summary: { type: "string", maxLength: LIMITS.summary, description: "One short sentence on how the period looked." },
    observations: {
      type: "array",
      maxItems: LIMITS.observations,
      description: "What deserves the Owner's attention. Empty when nothing does.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["level", "sites", "title", "explanation", "evidence"],
        properties: {
          level: { type: "string", enum: [...LEVELS] },
          sites: { type: "array", maxItems: LIMITS.sites, items: { type: "string", maxLength: LIMITS.host }, description: "Host names of the Sites involved." },
          title: { type: "string", maxLength: LIMITS.title },
          explanation: { type: "string", maxLength: LIMITS.explanation },
          ongoing: { type: "boolean", description: "True when this is the same thing the previous Review reported, continuing. Leave out when it is new." },
          evidence: {
            type: "array",
            maxItems: LIMITS.evidence,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                client: { type: "string", maxLength: LIMITS.client },
                path: { type: "string", maxLength: LIMITS.path },
                status: { type: "integer", minimum: 100, maximum: 599 },
                count: { type: "integer", minimum: 0 },
                period: { type: "string", maxLength: LIMITS.period },
              },
            },
          },
        },
      },
    },
  },
};

/**
 * Some models write a list as a string of JSON instead of a list. That is unambiguous, so it is accepted; anything
 * else that is not a list stays as it was and is rejected by the caller.
 */
function asList(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

type Parsed = { ok: true; result: ReviewResult } | { ok: false; error: string };

const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() !== "" && value.length <= max ? value.trim() : null);
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

function parseEvidence(value: unknown): Evidence | null {
  if (!isRecord(value) || !onlyKeys(value, ["client", "path", "status", "count", "period"])) return null;
  const out: Evidence = {};
  for (const [key, max] of [["client", LIMITS.client], ["path", LIMITS.path], ["period", LIMITS.period]] as const) {
    if (value[key] === undefined) continue;
    const field = text(value[key], max);
    if (field === null) return null;
    out[key] = field;
  }
  if (value.status !== undefined) {
    if (!Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599) return null;
    out.status = value.status as number;
  }
  if (value.count !== undefined) {
    if (!Number.isInteger(value.count) || (value.count as number) < 0) return null;
    out.count = value.count as number;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parseObservation(value: unknown): Observation | null {
  if (!isRecord(value) || !onlyKeys(value, ["level", "sites", "title", "explanation", "evidence", "ongoing"])) return null;
  if (value.ongoing !== undefined && typeof value.ongoing !== "boolean") return null;
  const level = LEVELS.find((l) => l === value.level);
  const title = text(value.title, LIMITS.title);
  const explanation = text(value.explanation, LIMITS.explanation);
  if (!level || !title || !explanation) return null;
  const siteList = asList(value.sites);
  const evidenceList = asList(value.evidence);
  if (!Array.isArray(siteList) || siteList.length > LIMITS.sites || !Array.isArray(evidenceList) || evidenceList.length > LIMITS.evidence) return null;
  const sites = siteList.map((site) => text(site, LIMITS.host));
  const evidence = evidenceList.map(parseEvidence);
  if (sites.includes(null) || evidence.includes(null)) return null;
  return { level, sites: sites as string[], title, explanation, evidence: evidence as Evidence[], ...(value.ongoing !== undefined && { ongoing: value.ongoing as boolean }) };
}

/** Checks the text of the tool call's arguments. The error says what was wrong without repeating the model's text. */
export function parseReviewResult(argumentsText: string): Parsed {
  let data: unknown;
  try {
    data = JSON.parse(argumentsText);
  } catch {
    return { ok: false, error: "The model's answer was not complete JSON. It may have run out of tokens." };
  }
  if (!isRecord(data) || !onlyKeys(data, ["summary", "observations"])) return { ok: false, error: "The model's answer did not have the fixed structure (a summary and a list of observations)." };
  const summary = text(data.summary, LIMITS.summary);
  if (!summary) return { ok: false, error: "The model's answer had no usable summary." };
  const list = asList(data.observations);
  if (!Array.isArray(list)) return { ok: false, error: `The model's answer had no usable list of observations: "observations" must be a JSON list, and was ${list === null ? "null" : typeof list}.` };
  if (list.length > LIMITS.observations) return { ok: false, error: `The model's answer had no usable list of observations: it had ${list.length}, and ${LIMITS.observations} is the most.` };
  const observations: Observation[] = [];
  for (const [index, item] of list.entries()) {
    const observation = parseObservation(item);
    if (!observation) return { ok: false, error: `Observation ${index + 1} in the model's answer did not fit the fixed structure.` };
    observations.push(observation);
  }
  return { ok: true, result: { summary, observations } };
}
