export default class StudioGraphicsUI {

    constructor(
        root,
        graphicsManager,
        graphicId = "lower-third-basic",
        assetLibrary = null
    ) {
        this.root = root;
        this.graphicsManager = graphicsManager;
        this.graphicId = graphicId;
        this.assetLibrary = assetLibrary;
        this.logoGraphicId = "channel-logo";
        this.started = false;
        this.feedbackMessage = "";
        this.logoFeedbackMessage = "";

        this.handleInput = this.handleInput.bind(this);
        this.handleApplyPreview = this.handleApplyPreview.bind(this);
        this.handleHidePreview = this.handleHidePreview.bind(this);
        this.handleTakeGraphic = this.handleTakeGraphic.bind(this);
        this.handleHideProgram = this.handleHideProgram.bind(this);
        this.renderFromState = this.renderFromState.bind(this);
        this.handleLogoInput = this.handleLogoInput.bind(this);
        this.handleLogoApplyPreview = this.handleLogoApplyPreview.bind(this);
        this.handleLogoHidePreview = this.handleLogoHidePreview.bind(this);
        this.handleLogoTake = this.handleLogoTake.bind(this);
        this.handleLogoHideProgram = this.handleLogoHideProgram.bind(this);
        this.handleLogoResetDefault = this.handleLogoResetDefault.bind(this);
        this.handleLogoAssetChange = this.handleLogoAssetChange.bind(this);
        this.renderLogoAssets = this.renderLogoAssets.bind(this);
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
        this.logoAssetInput = this.root.querySelector("#studio-logo-asset");
        this.logoAssetSelect = this.root.querySelector(
            "#studio-logo-asset-select"
        );
        this.logoPositionInput = this.root.querySelector(
            "#studio-logo-position"
        );
        this.logoApplyButton = this.root.querySelector(
            "#studio-logo-apply-preview"
        );
        this.logoHidePreviewButton = this.root.querySelector(
            "#studio-logo-hide-preview"
        );
        this.logoTakeButton = this.root.querySelector("#studio-logo-take");
        this.logoHideProgramButton = this.root.querySelector(
            "#studio-logo-hide-program"
        );
        this.logoResetButton = this.root.querySelector(
            "#studio-logo-reset-default"
        );
        this.logoPreviewStatus = this.root.querySelector(
            "#studio-logo-preview-status"
        );
        this.logoProgramStatus = this.root.querySelector(
            "#studio-logo-program-status"
        );
        this.logoFeedback = this.root.querySelector("#studio-logo-feedback");

        if (!this.titleInput || !this.subtitleInput || !this.applyButton ||
            !this.hidePreviewButton || !this.takeButton ||
            !this.hideProgramButton || !this.previewStatus ||
            !this.programStatus || !this.feedback || !this.logoAssetInput ||
            !this.logoAssetSelect ||
            !this.logoPositionInput || !this.logoApplyButton ||
            !this.logoHidePreviewButton || !this.logoTakeButton ||
            !this.logoHideProgramButton || !this.logoResetButton ||
            !this.logoPreviewStatus || !this.logoProgramStatus ||
            !this.logoFeedback) {
            return;
        }

        const logo = this.graphicsManager.getGraphic(this.logoGraphicId);

        if (logo) {
            this.logoAssetInput.value = logo.asset;
            this.logoPositionInput.value = logo.position;
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
        this.logoAssetInput.addEventListener("input", this.handleLogoInput);
        this.logoAssetSelect.addEventListener(
            "change",
            this.handleLogoAssetChange
        );
        this.logoPositionInput.addEventListener("change", this.handleLogoInput);
        this.logoApplyButton.addEventListener(
            "click",
            this.handleLogoApplyPreview
        );
        this.logoHidePreviewButton.addEventListener(
            "click",
            this.handleLogoHidePreview
        );
        this.logoTakeButton.addEventListener("click", this.handleLogoTake);
        this.logoHideProgramButton.addEventListener(
            "click",
            this.handleLogoHideProgram
        );
        this.logoResetButton.addEventListener(
            "click",
            this.handleLogoResetDefault
        );

        this.unsubscribePreview = this.graphicsManager.subscribe(
            "preview",
            this.renderFromState
        );
        this.unsubscribeProgram = this.graphicsManager.subscribe(
            "program",
            this.renderFromState
        );
        this.unsubscribeAssets = this.assetLibrary?.subscribe(
            this.renderLogoAssets
        );
        this.started = true;
        this.renderLogoAssets(this.assetLibrary?.getAssets() || []);
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
        this.logoAssetInput.removeEventListener("input", this.handleLogoInput);
        this.logoAssetSelect.removeEventListener(
            "change",
            this.handleLogoAssetChange
        );
        this.logoPositionInput.removeEventListener(
            "change",
            this.handleLogoInput
        );
        this.logoApplyButton.removeEventListener(
            "click",
            this.handleLogoApplyPreview
        );
        this.logoHidePreviewButton.removeEventListener(
            "click",
            this.handleLogoHidePreview
        );
        this.logoTakeButton.removeEventListener("click", this.handleLogoTake);
        this.logoHideProgramButton.removeEventListener(
            "click",
            this.handleLogoHideProgram
        );
        this.logoResetButton.removeEventListener(
            "click",
            this.handleLogoResetDefault
        );
        this.unsubscribePreview?.();
        this.unsubscribeProgram?.();
        this.unsubscribePreview = null;
        this.unsubscribeProgram = null;
        this.unsubscribeAssets?.();
        this.unsubscribeAssets = null;
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

    handleLogoInput() {
        const selected = this.assetLibrary?.getAsset(this.logoAssetSelect.value);
        if (!selected || selected.url !== this.resolveLogoUrl(
            this.logoAssetInput.value
        )) {
            this.logoAssetSelect.value = "";
        }
        this.logoFeedbackMessage = this.getLogoDraftPayload()
            ? ""
            : "Enter a valid HTTP(S) logo URL or relative path.";
        this.renderFromState();
    }

    handleLogoAssetChange() {
        const asset = this.assetLibrary?.getAsset(this.logoAssetSelect.value);
        if (!asset || asset.kind !== "logo") {
            return;
        }
        this.logoAssetInput.value = asset.url;
        this.logoFeedbackMessage = `${asset.name} loaded into logo draft.`;
        this.renderFromState();
    }

    renderLogoAssets(assets) {
        if (!this.started) {
            return;
        }
        const selected = this.logoAssetSelect.value;
        const manual = document.createElement("option");
        manual.value = "";
        manual.textContent = "Manual URL / path";
        const options = assets.filter((asset) => asset.kind === "logo")
            .map((asset) => {
                const option = document.createElement("option");
                option.value = asset.id;
                option.textContent = `${asset.name} (${asset.origin.toUpperCase()})`;
                return option;
            });
        this.logoAssetSelect.replaceChildren(manual, ...options);
        const currentUrl = this.resolveLogoUrl(this.logoAssetInput.value);
        const matching = assets.find((asset) =>
            asset.kind === "logo" && asset.url === currentUrl
        );
        this.logoAssetSelect.value = options.some((option) =>
            option.value === selected
        ) ? selected : matching?.id || "";
    }

    handleLogoApplyPreview() {
        const payload = this.getLogoDraftPayload();

        if (!payload) {
            this.logoFeedbackMessage =
                "Enter a valid HTTP(S) logo URL or relative path.";
            this.renderFromState();
            return;
        }

        this.graphicsManager.setGraphicState(this.logoGraphicId, {
            consumer: "preview",
            visible: true,
            payload
        });
        this.logoFeedbackMessage = "Preview logo applied.";
        this.renderFromState();
    }

    handleLogoHidePreview() {
        this.graphicsManager.hide(this.logoGraphicId, { consumer: "preview" });
        this.logoFeedbackMessage = "Preview logo hidden.";
        this.renderFromState();
    }

    handleLogoTake() {
        this.graphicsManager.copyGraphicState(this.logoGraphicId, {
            from: "preview",
            to: "program"
        });
        this.logoFeedbackMessage = "Preview logo copied to Program.";
        this.renderFromState();
    }

    handleLogoHideProgram() {
        this.graphicsManager.hide(this.logoGraphicId, { consumer: "program" });
        this.logoFeedbackMessage = "Program logo hidden.";
        this.renderFromState();
    }

    handleLogoResetDefault() {
        const logo = this.graphicsManager.getGraphic(this.logoGraphicId);

        if (!logo) {
            return;
        }

        this.logoAssetInput.value = logo.asset;
        const matching = this.assetLibrary?.getAssets("logo").find(
            (asset) => asset.url === logo.asset
        );
        this.logoAssetSelect.value = matching?.id || "";
        this.logoPositionInput.value = logo.position;
        this.logoFeedbackMessage = "Default logo loaded into draft.";
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

        const logoAvailable = Boolean(
            this.graphicsManager.getGraphic(this.logoGraphicId)
        );
        const logoPreview = this.getGraphicState(
            "preview",
            this.logoGraphicId
        );
        const logoProgram = this.getGraphicState(
            "program",
            this.logoGraphicId
        );

        this.logoApplyButton.disabled = !logoAvailable ||
            !this.getLogoDraftPayload();
        this.logoHidePreviewButton.disabled = !logoAvailable ||
            !logoPreview.visible;
        this.logoTakeButton.disabled = !logoAvailable ||
            this.statesEqual(logoPreview, logoProgram);
        this.logoHideProgramButton.disabled = !logoAvailable ||
            !logoProgram.visible;
        this.logoResetButton.disabled = !logoAvailable;
        this.logoPreviewStatus.textContent = logoPreview.visible
            ? "Visible"
            : "Hidden";
        this.logoProgramStatus.textContent = logoProgram.visible
            ? "Visible"
            : "Hidden";
        this.logoFeedback.textContent = logoAvailable
            ? this.logoFeedbackMessage
            : "Channel logo unavailable.";
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
        return this.getGraphicState(consumer, this.graphicId);
    }

    getGraphicState(consumer, graphicId) {
        const entry = this.graphicsManager
            .getVisibleGraphics(consumer)
            .find(({ graphic }) => graphic.id === graphicId);

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

        return JSON.stringify(left.payload) === JSON.stringify(right.payload);
    }

    getLogoDraftPayload() {
        const graphic = this.graphicsManager.getGraphic(this.logoGraphicId);
        const asset = this.logoAssetInput.value.trim();
        const position = this.logoPositionInput.value;

        if (!graphic || !asset || ![
            "top-left",
            "top-right",
            "bottom-left",
            "bottom-right"
        ].includes(position)) {
            return null;
        }

        try {
            const url = new URL(asset, graphic.asset);

            if (url.protocol !== "http:" && url.protocol !== "https:") {
                return null;
            }

            return { asset, position };
        }
        catch {
            return null;
        }
    }

    isAssetReferenced(asset) {
        if (!asset || asset.kind !== "logo") {
            return false;
        }
        if (this.logoAssetSelect?.value === asset.id) {
            return true;
        }
        return ["preview", "program"].some((consumer) => {
            const state = this.getGraphicState(consumer, this.logoGraphicId);
            return state.visible && state.payload?.asset === asset.url;
        });
    }

    resolveLogoUrl(value) {
        const graphic = this.graphicsManager.getGraphic(this.logoGraphicId);
        try {
            const url = new URL(value, graphic?.asset);
            return ["http:", "https:"].includes(url.protocol) ? url.href : null;
        }
        catch {
            return null;
        }
    }
}
