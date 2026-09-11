import { createAutoLiveLossSlate, AUTO_LIVE_LOSS_LOGO } from "./AutoLiveLossSlate.js";

export const AUTO_LIVE_ENTRY_ID = "autolive-entry-slate";
export const AUTO_LIVE_ENTRY_TITLE = "COLLEGAMENTO LIVE IN PREPARAZIONE";
export const AUTO_LIVE_ENTRY_MESSAGE = "La trasmissione inizierà tra pochi istanti";

export function createAutoLiveEntrySlate(logoUrl = AUTO_LIVE_LOSS_LOGO) {
    const slate = createAutoLiveLossSlate(logoUrl);
    slate.removeAttribute("data-autolive-loss-slate");
    slate.setAttribute("data-autolive-entry-slate", "");
    slate.children[1].textContent = AUTO_LIVE_ENTRY_TITLE;
    const message = document.createElement("span");
    message.textContent = AUTO_LIVE_ENTRY_MESSAGE;
    Object.assign(message.style, { fontSize: "clamp(8px, 2cqw, 30px)", color: "#c7ccd4" });
    slate.appendChild(message);
    return slate;
}
