import { QUALITY_GATE } from '@window/shared';

/**
 * The quality gate.
 *
 * A listing is rejected before reaching the feed if any of these hold. The gate
 * runs before embedding and before clustering, because every stage after it
 * costs money per listing and there is no point spending it on something that
 * can never be shown.
 *
 * Rejected listings are kept with `status: "rejected"` and a reason rather than
 * deleted: a source whose extractor silently regresses shows up here as a
 * sudden spike in one reason code, and that is only visible if the rejections
 * are still there to count.
 */

export type RejectReason =
  | 'no_acceptable_image'
  | 'price_missing'
  | 'title_too_short'
  | 'classification_confidence'
  | 'blocked_domain'
  | 'scam_heuristic';

export interface GateInput {
  title: string;
  priceAmount: number | null;
  /** Short edge of the best image, or null when there is no usable image. */
  bestImageShortEdge: number | null;
  classificationConfidence: number;
  sourceDomain: string;
  blockedDomains: ReadonlySet<string>;
  /** Cluster median, when this listing already matched a cluster. */
  clusterMedianPrice: number | null;
  sellerAccountAgeDays: number | null;
}

export interface GateResult {
  passed: boolean;
  reason: RejectReason | null;
  detail: string | null;
}

const PASS: GateResult = { passed: true, reason: null, detail: null };

export function applyQualityGate(input: GateInput): GateResult {
  if (input.blockedDomains.has(input.sourceDomain)) {
    return { passed: false, reason: 'blocked_domain', detail: input.sourceDomain };
  }

  if (input.priceAmount === null || input.priceAmount <= 0) {
    return { passed: false, reason: 'price_missing', detail: 'price is zero or absent' };
  }

  if (input.title.trim().length < QUALITY_GATE.minTitleLength) {
    return {
      passed: false,
      reason: 'title_too_short',
      detail: `${input.title.trim().length} characters`,
    };
  }

  if (
    input.bestImageShortEdge === null ||
    input.bestImageShortEdge < QUALITY_GATE.minImageShortEdge
  ) {
    return {
      passed: false,
      reason: 'no_acceptable_image',
      detail:
        input.bestImageShortEdge === null
          ? 'no image'
          : `best image is ${input.bestImageShortEdge}px on the short edge`,
    };
  }

  if (input.classificationConfidence < QUALITY_GATE.minClassificationConfidence) {
    return {
      passed: false,
      reason: 'classification_confidence',
      detail: input.classificationConfidence.toFixed(2),
    };
  }

  // The scam heuristic: a price under 15% of the cluster median from an account
  // too new to have a reputation. Either alone is common and innocent; together
  // they are the shape of a listing that will not ship.
  if (
    input.clusterMedianPrice !== null &&
    input.clusterMedianPrice > 0 &&
    input.priceAmount < input.clusterMedianPrice * QUALITY_GATE.scamPriceShareOfMedian &&
    input.sellerAccountAgeDays !== null &&
    input.sellerAccountAgeDays < QUALITY_GATE.newSellerAgeDays
  ) {
    const share = Math.round((input.priceAmount / input.clusterMedianPrice) * 100);
    return {
      passed: false,
      reason: 'scam_heuristic',
      detail: `priced at ${share}% of the cluster median by an account ${Math.round(
        input.sellerAccountAgeDays,
      )} days old`,
    };
  }

  return PASS;
}
