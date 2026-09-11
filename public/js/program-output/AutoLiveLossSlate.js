// Reserved image graphic: presentation only, never a BREAK scene or TAKE.
export const AUTO_LIVE_LOSS_SLATE_ID = "autolive-loss-slate";
export const AUTO_LIVE_LOSS_TEXT = "SEGNALE LIVE TEMPORANEAMENTE NON DISPONIBILE";
export const AUTO_LIVE_LOSS_LOGO = new URL("../../assets/logo/logo-lz.svg", import.meta.url).href;

export function createAutoLiveLossSlate(logoUrl = AUTO_LIVE_LOSS_LOGO) {
    const slate = document.createElement("div");
    slate.setAttribute("data-autolive-loss-slate", "");
    Object.assign(slate.style, { position: "absolute", inset: "0", zIndex: "100",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        gap: "5%", background: "radial-gradient(circle at center, #18212d, #07090d 70%)",
        color: "white", textAlign: "center", pointerEvents: "none", containerType: "inline-size" });
    const logo = document.createElement("img");
    logo.src = logoUrl; logo.alt = "";
    Object.assign(logo.style, { width: "18%", maxHeight: "22%", objectFit: "contain" });
    const title = document.createElement("strong");
    title.textContent = AUTO_LIVE_LOSS_TEXT;
    Object.assign(title.style, { fontFamily: "Arial, sans-serif", fontSize: "clamp(9px, 3cqw, 48px)",
        lineHeight: "1.3", maxWidth: "90%" });
    slate.appendChild(logo); slate.appendChild(title);
    return slate;
}
