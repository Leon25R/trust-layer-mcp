import { normalizePublicDomain } from "./publicLookup.js";

export const FEEDBACK_CATEGORIES = ["source_unclear", "display_unclear", "load_failed", "helpful"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export interface PublicFeedbackInput {
  category: FeedbackCategory;
  domain?: string;
}

export class FeedbackValidationError extends Error {
  constructor() {
    super("invalid public feedback");
    this.name = "FeedbackValidationError";
  }
}

/** Validates the deliberately small feedback contract without persisting it. */
export function parsePublicFeedback(value: unknown): PublicFeedbackInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FeedbackValidationError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "category" && key !== "domain")) throw new FeedbackValidationError();
  if (typeof record.category !== "string" || !FEEDBACK_CATEGORIES.includes(record.category as FeedbackCategory)) throw new FeedbackValidationError();
  if (record.domain !== undefined && typeof record.domain !== "string") throw new FeedbackValidationError();
  return {
    category: record.category as FeedbackCategory,
    ...(record.domain === undefined || record.domain === "" ? {} : { domain: normalizePublicDomain(record.domain) }),
  };
}
