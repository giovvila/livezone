import AutoLiveLossPresentation from "./AutoLiveLossPresentation.js";
import { createAutoLiveEntrySlate } from "../program-output/AutoLiveEntrySlate.js";
import trace from "../core/RuntimeTrace.js";

export default class AutoLiveEntryPresentation extends AutoLiveLossPresentation {
    constructor(options) {
        super(options);
        this.entryPresentation = null;
        const changed = this.handleProgramChanged;
        this.handleProgramChanged = () => { changed(); this.setEntry(null); };
    }
    update(snapshot) {
        if (snapshot.phase === "PREPARING") {
            this.stopObserving();
            this.setPresentation(null);
            this.setEntry({ sessionId: snapshot.session.sessionId,
                startedAt: snapshot.session.startedAt, logoUrl: this.logoUrl });
            return;
        }
        if (this.entryPresentation && !snapshot.session && this.controller.closingSession &&
            !["RESTORED", "OPERATOR_OWNS_PROGRAM"].includes(snapshot.diagnostics.recoveryResult)) return;
        this.setEntry(null);
        super.update(snapshot);
    }
    setEntry(value) {
        if (JSON.stringify(value) === JSON.stringify(this.entryPresentation)) return;
        this.entryPresentation = value;
        trace.record("entry-slate", value ? "show-request" : "hide-request", {
            sessionId: value?.sessionId, revision: this.output.revision,
            phase: this.controller.session?.phase || "CLOSED" });
        this.entryElement?.remove(); this.entryElement = null;
        if (value && this.root) {
            this.entryElement = createAutoLiveEntrySlate(value.logoUrl);
            this.root.appendChild(this.entryElement);
        }
        this.output.setAutoLiveEntrySlate(value);
    }
    destroy() {
        super.destroy();
        this.setEntry(null);
    }
}
