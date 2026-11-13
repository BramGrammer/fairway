/**
 * When a Review is worth an Alert (ADR 0006, 0009): at least one Observation that is new, not `ongoing`, at or above
 * the level the Owner chose. This module only decides and words it; the Event and the Alert are the event log's.
 *
 * Observations come from a model, so every text that leaves here is plain: no control characters, no line breaks, cut short.
 */

import type { ReviewLevel } from "./alert-policy.js";
import { LEVELS, type Level, type Observation } from "./review-result.js";

/** What the Event keeps about a Review that found something. */
export interface ReviewFound {
  reviewId: number;
  /** The highest level among the qualifying Observations. */
  level: Level;
  /** How many Observations qualified. */
  count: number;
  /** The Sites of the qualifying Observations, in order of appearance. */
  sites: string[];
  /** The title of the most serious qualifying Observation. */
  title: string;
}

/** What the Event keeps about Reviews that keep failing. */
export interface ReviewFailing {
  reviewId: number;
  /** Why the latest one failed, as one plain line. */
  reason: string;
}

const MAX_REASON = 300;
const MAX_TITLE = 120;
const MAX_SITE = 100;
const MAX_SITES = 10;
/** How many Sites the words of the Alert name before "and N more". */
const SITES_IN_MESSAGE = 3;

const rank = (level: Level) => LEVELS.indexOf(level);

/** Text from the model as one plain line: control characters and line breaks become spaces, and it is cut to `max`. */
export function plainText(text: unknown, max: number): string {
  const line = (typeof text === "string" ? text : "")
    // Control characters, line and paragraph separators, and the zero-width and direction marks that hide or reorder text.
    .replace(/[\p{Cc}\p{Zl}\p{Zp}​-‏‪-‮⁦-⁩﻿]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line;
}

/** The Event's data for a finished Review, or null when no Observation qualifies or the Owner chose never. */
export function reviewFound(review: { id: number; observations: Observation[] }, threshold: ReviewLevel): ReviewFound | null {
  if (threshold === "never") return null;
  const qualifying = review.observations.filter((o) => !o.ongoing && rank(o.level) >= rank(threshold));
  if (qualifying.length === 0) return null;
  // The first of the most serious ones, so that equal levels keep the model's order.
  const top = qualifying.reduce((best, o) => (rank(o.level) > rank(best.level) ? o : best));
  const sites = [...new Set(qualifying.flatMap((o) => o.sites.map((site) => plainText(site, MAX_SITE)).filter(Boolean)))].slice(0, MAX_SITES);
  return { reviewId: review.id, level: top.level, count: qualifying.length, sites, title: plainText(top.title, MAX_TITLE) || "Untitled observation" };
}

/** The Event's message and the Alert's body: the level, the Sites and the most serious Observation. */
export function reviewFoundMessage(found: Pick<ReviewFound, "level" | "count" | "sites" | "title">): string {
  const shown = found.sites.slice(0, SITES_IN_MESSAGE).join(", ");
  const more = found.sites.length - SITES_IN_MESSAGE;
  const where = found.sites.length === 0 ? "" : ` on ${shown}${more > 0 ? ` and ${more} more` : ""}`;
  const count = found.count === 1 ? "1 observation" : `${found.count} observations`;
  return `Review found something${where} (${found.level}, ${count}): ${found.title}`;
}

/** The Event's message and the Alert's body when Reviews keep failing. */
export function reviewFailingMessage(failing: Pick<ReviewFailing, "reason">): string {
  return `Reviews are failing: ${failing.reason}`;
}

/** Where the Alert leads: the Review in Fairway. */
export function reviewLink(publicUrl: string, reviewId: number): string {
  return `${publicUrl.replace(/\/+$/, "")}/reviews?review=${reviewId}`;
}

/**
 * What a finished Review leads to: an Event when it found something at or above the level the Owner has chosen at that moment.
 * `Reviews` is given this as its `onFinished`, so it never meets the event log.
 */
export function alertOnFinished(options: { level: () => ReviewLevel; record: (found: ReviewFound) => void; recordFailing: (failing: ReviewFailing) => void }) {
  return (review: { id: number; status: string; failure?: string | null; observations: Observation[] }, context: { failedInARow: number }): void => {
    if (review.status === "failed") {
      // The second failure in a row is reported; the streak's length is read from the stored Reviews, so it holds after a restart,
      // and no more is reported until a Review has been done.
      if (context.failedInARow === 2) options.recordFailing({ reviewId: review.id, reason: plainText(review.failure, MAX_REASON) || "No reason was recorded." });
      return;
    }
    if (review.status !== "done") return;
    const found = reviewFound(review, options.level());
    if (found) options.record(found);
  };
}
