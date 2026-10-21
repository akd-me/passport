import type { PromotionOffer } from "@passport/types";
import { useState } from "react";
import { api, type TrustData } from "../api";
import { Feedback, Icon } from "../components/ui";
import { categoryLabel } from "../labels";
import { logger } from "../logger";
import { useResource, useTask } from "../state";
import { TrustLadder } from "./TrustControls";
import { modeLabel } from "./trust-modes";

const DISMISSED = "passport.dismissedOffers";

const offerKey = (offer: PromotionOffer) => `${offer.category}:${offer.to}`;

function readDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED) ?? "[]") as string[];
  } catch {
    // Promotion dismissal storage could not be read.
    logger.warn("Promotion dismissal storage could not be read");

    return [];
  }
}

/** Promotion offers from the policy engine, raised where the work happens. */
export function PromotionPrompts() {
  const trust = useResource<TrustData>("/trust"),
    task = useTask(),
    [dismissed, setDismissed] = useState(readDismissed);
  const offers =
    trust.data?.promotionOffers.filter(
      (offer) =>
        !dismissed.includes(offerKey(offer)) &&
        !trust.data!.categories.find((c) => c.category === offer.category)?.pinnedLevel,
    ) ?? [];
  if (!offers.length) {
    return null;
  }
  const dismiss = (offer: PromotionOffer) => {
    const next = [...dismissed, offerKey(offer)];
    setDismissed(next);
    try {
      localStorage.setItem(DISMISSED, JSON.stringify(next));
    } catch {
      // Promotion dismissal could not be persisted; retaining session state.
      logger.warn("Promotion dismissal could not be persisted; retaining session state");

      /* Session-only dismissal is acceptable. */
    }
  };
  return (
    <div className="offers">
      {offers.map((offer) => (
        <div className="offer" key={offerKey(offer)} role="status">
          <TrustLadder level={offer.to} />
          <p>
            <strong>{categoryLabel(offer.category)}</strong>: {offer.evidence.approvalsUnchanged} of{" "}
            {offer.evidence.approvals} approved without changes in {offer.evidence.window}. Let
            Passport handle these on {modeLabel(offer.to)}?
          </p>
          <button
            type="button"
            className="btn btn-sm"
            disabled={task.busy}
            onClick={() =>
              task.run(
                () => api.pin(offer.category, offer.to),
                `${categoryLabel(offer.category)} now run on ${modeLabel(offer.to)}, within your global mode.`,
              )
            }
          >
            Allow {modeLabel(offer.to)}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Dismiss the ${categoryLabel(offer.category)} suggestion`}
            onClick={() => dismiss(offer)}
          >
            <Icon name="close" size={14} />
          </button>
          <Feedback error={task.error} />
        </div>
      ))}
    </div>
  );
}
