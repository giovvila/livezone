export default class StudioGraphicsUI {

    constructor(root, graphicsManager, graphicId = "lower-third-basic") {
        this.root = root;
        this.graphicsManager = graphicsManager;
        this.graphicId = graphicId;
        this.started = false;
        this.feedbackMessage = "";

        this.handleInput = this.handleInput.bind(this);
        this.handleApplyPreview = this.handleApplyPreview.bind(this);
        this.handleHidePreview = this.handleHidePreview.bind(this);
        this.handleTakeGraphic = this.handleTakeGraphic.bind(this);
        this.handleHideProgram = this.handleHideProgram.bind(this);
        this.renderFromState = this.renderFromState.bind(this);
    }

    start() {
        if (this.started || !this.root || !this.graphicsManager) {
            return;
        }

        this.titleInput = this.root.querySelector("#studio-lower-third-title");
        this.subtitleInput = this.root.querySelector(
            "#studio-lower-third-subtitle"
        );
        this.applyButton = this.root.querySelector(
            "#studio-lower-third-apply-preview"
        );
        this.hidePreviewButton = this.root.querySelector(
            "#studio-lower-third-hide-preview"
        );
        this.takeButton = this.root.querySelector(
            "#studio-lower-third-take"
        );
        this.hideProgramButton = this.root.querySelector(
            "#studio-lower-third-hide-program"
        );
        this.previewStatus = this.root.querySelector(
            "#studio-lower-third-preview-status"
        );
        this.programStatus = this.root.querySelector(
            "#studio-lower-third-program-status"
        );
        this.feedback = this.root.querySelector(
            "#studio-lower-third-feedback"
        );

        if (!this.titleInput || !this.subtitleInput || !this.applyButton ||
            !this.hidePreviewButton || !this.takeButton ||
            !this.hideProgramButton || !this.previewStatus ||
            !this.programStatus || !this.feedback) {
            return;
        }

        this.titleInput.addEventListener("input", this.handleInput);
        this.subtitleInput.addEventListener("input", this.handleInput);
        this.applyButton.addEventListener("click", this.handleApplyPreview);
        this.hidePreviewButton.addEventListener(
            "click",
            this.handleHidePreview
        );
        this.takeButton.addEventListener("click", this.handleTakeGraphic);
        this.hideProgramButton.addEventListener(
            "click",
            this.handleHideProgram
        );

        this.unsubscribePreview = this.graphicsManager.subscribe(
            "preview",
            this.renderFromState
        );
        this.unsubscribeProgram = this.graphicsManager.subscribe(
            "program",
            this.renderFromState
        );
        this.started = true;
        this.renderFromState();
    }

    destroy() {
        if (!this.started) {
            return;
        }

        this.titleInput.removeEventListener("input", this.handleInput);
        this.subtitleInput.removeEventListener("input", this.handleInput);
        this.applyButton.removeEventListener("click", this.handleApplyPreview);
        this.hidePreviewButton.removeEventListener(
            "click",
            this.handleHidePreview
        );
        this.takeButton.removeEventListener("click", this.handleTakeGraphic);
        this.hideProgramButton.removeEventListener(
            "click",
            this.handleHideProgram
        );
        this.unsubscribePreview?.();
        this.unsubscribeProgram?.();
        this.unsubscribePreview = null;
        this.unsubscribeProgram = null;
        this.started = false;
    }

    handleInput() {
        this.feedbackMessage = this.getDraftPayload()
            ? ""
            : "Title is required.";
        this.renderFromState();
    }

    handleApplyPreview() {
        const payload = this.getDraftPayload();

        if (!payload) {
            this.feedbackMessage = "Title is required.";
            this.renderFromState();
            return;
        }

        this.graphicsManager.setGraphicState(this.graphicId, {
            consumer: "preview",
            visible: true,
            payload
        });
        this.feedbackMessage = "Preview graphic applied.";
        this.renderFromState();
    }

    handleHidePreview() {
        this.graphicsManager.setGraphicState(this.graphicId, {
            consumer: "preview",
            visible: false
        });
        this.feedbackMessage = "Preview graphic hidden.";
        this.renderFromState();
    }

    handleTakeGraphic() {
        this.graphicsManager.copyGraphicState(this.graphicId, {
            from: "preview",
            to: "program"
        });
        this.feedbackMessage = "Preview graphic copied to Program.";
        this.renderFromState();
    }

    handleHideProgram() {
        this.graphicsManager.setGraphicState(this.graphicId, {
            consumer: "program",
            visible: false
        });
        this.feedbackMessage = "Program graphic hidden.";
        this.renderFromState();
    }

    renderFromState() {
        if (!this.started) {
            return;
        }

        const available = Boolean(
            this.graphicsManager.getGraphic(this.graphicId)
        );
        const preview = this.getConsumerState("preview");
        const program = this.getConsumerState("program");

        this.applyButton.disabled = !available || !this.getDraftPayload();
        this.hidePreviewButton.disabled = !available || !preview.visible;
        this.takeButton.disabled = !available ||
            this.statesEqual(preview, program);
        this.hideProgramButton.disabled = !available || !program.visible;
        this.previewStatus.textContent = preview.visible ? "Visible" : "Hidden";
        this.programStatus.textContent = program.visible ? "Visible" : "Hidden";
        this.feedback.textContent = available
            ? this.feedbackMessage
            : "Lower-third graphic unavailable.";
    }

    getDraftPayload() {
        const title = this.titleInput.value.trim();
        const subtitle = this.subtitleInput.value.trim();

        if (!title || Array.from(title).length > 80 ||
            Array.from(subtitle).length > 120) {
            return null;
        }

        return { title, subtitle };
    }

    getConsumerState(consumer) {
        const entry = this.graphicsManager
            .getVisibleGraphics(consumer)
            .find(({ graphic }) => graphic.id === this.graphicId);

        return entry
            ? { visible: true, payload: entry.payload }
            : { visible: false, payload: null };
    }

    statesEqual(left, right) {
        if (left.visible !== right.visible) {
            return false;
        }

        if (!left.visible) {
            return true;
        }

        return left.payload?.title === right.payload?.title &&
            left.payload?.subtitle === right.payload?.subtitle;
    }
}
