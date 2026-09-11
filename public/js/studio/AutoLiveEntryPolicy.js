import { LIVE_SOURCE_RETRY_DELAY_MS, LIVE_SOURCE_READINESS_TIMEOUT_MS } from "./LiveSourceMonitor.js";
import { LOSS_GRACE_MS } from "./DominantLiveController.js";

export const AUTO_LIVE_ENTRY_STABILITY_MS = 30 * 1000;
// One readiness attempt, one retry interval and the existing loss grace.
export const AUTO_LIVE_ENTRY_ABANDONMENT_MS =
    LIVE_SOURCE_READINESS_TIMEOUT_MS + LIVE_SOURCE_RETRY_DELAY_MS + LOSS_GRACE_MS;
