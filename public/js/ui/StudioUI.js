import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import StudioStateManager from "../core/StudioStateManager.js";

export default class StudioUI {

    constructor(root, transitionCoordinator) {
        this.root = root;
        this.transitionCoordinator = transitionCoordinator;
        this.started = false;

        this.handleSceneListClick = this.handleSceneListClick.bind(this);
        this.handleTakeClick = this.handleTakeClick.bind(this);
        this.handleTransitionChange = this.handleTransitionChange.bind(this);
        this.renderFromState = this.renderFromState.bind(this);
    }

    start() {
        if (this.started) {
            return;
        }

        if (!this.root) {
            return;
        }

        this.sceneList = this.root.querySelector("#studio-scene-list");
        this.emptyState = this.root.querySelector("#studio-empty-state");
        this.takeButton = this.root.querySelector("#studio-take");
        this.transitionSelect = this.root.querySelector(
            "#studio-transition-type"
        );

        if (
            !this.sceneList || !this.emptyState || !this.takeButton ||
            !this.transitionSelect ||
            !this.transitionCoordinator
        ) {
            return;
        }

        this.sceneList.addEventListener("click", this.handleSceneListClick);
        this.takeButton.addEventListener("click", this.handleTakeClick);
        this.transitionSelect.addEventListener(
            "change",
            this.handleTransitionChange
        );
        this.transitionSelect.value = "cut";
        this.selectedTransition = "cut";

        this.studioEvents = [
            Events.STUDIO_SCENE_REGISTERED,
            Events.STUDIO_SCENE_UNREGISTERED,
            Events.STUDIO_PREVIEW_CHANGED,
            Events.STUDIO_PROGRAM_CHANGED
        ];

        this.studioEvents.forEach((event) => {
            EventBus.on(event, this.renderFromState);
        });
        this.unsubscribeTransition = this.transitionCoordinator.subscribe(
            this.renderFromState
        );

        this.renderFromState();
        this.started = true;
    }

    destroy() {
        if (!this.started) {
            return;
        }

        this.sceneList.removeEventListener("click", this.handleSceneListClick);
        this.takeButton.removeEventListener("click", this.handleTakeClick);
        this.transitionSelect.removeEventListener(
            "change",
            this.handleTransitionChange
        );

        this.studioEvents.forEach((event) => {
            EventBus.off(event, this.renderFromState);
        });
        this.unsubscribeTransition?.();

        this.started = false;
        this.studioEvents = null;
        this.unsubscribeTransition = null;
        this.sceneList = null;
        this.emptyState = null;
        this.takeButton = null;
        this.transitionSelect = null;
        this.selectedTransition = null;
    }

    handleSceneListClick(event) {
        const sceneButton = event.target.closest("[data-studio-scene-id]");

        if (!sceneButton || !this.sceneList.contains(sceneButton)) {
            return;
        }

        StudioStateManager.setPreviewScene(
            sceneButton.dataset.studioSceneId,
            {
                source: "operator",
                reason: "studio-scene-selection"
            }
        );
    }

    handleTakeClick() {
        const type = this.selectedTransition === "dissolve"
            ? "dissolve"
            : "cut";

        this.transitionCoordinator.transition({
            type,
            durationMs: type === "dissolve" ? 400 : 0,
            source: "operator",
            reason: "manual-take"
        });
    }

    handleTransitionChange() {
        this.selectedTransition = this.transitionSelect.value === "dissolve"
            ? "dissolve"
            : "cut";
    }

    renderFromState() {
        const scenes = StudioStateManager.getScenes();
        const previewSceneId = StudioStateManager.getPreviewSceneId();
        const programSceneId = StudioStateManager.getProgramSceneId();
        this.sceneList.replaceChildren();

        scenes.forEach((scene) => {
            this.sceneList.appendChild(
                this.createSceneButton(scene, previewSceneId, programSceneId)
            );
        });

        this.emptyState.hidden = scenes.length !== 0;

        const preview = scenes.find((scene) => scene.id === previewSceneId);

        this.takeButton.disabled = !preview ||
            previewSceneId === programSceneId ||
            this.transitionCoordinator.isBusy();
    }

    createSceneButton(scene, previewSceneId, programSceneId) {
        const button = document.createElement("button");
        const name = document.createElement("span");
        const type = document.createElement("span");
        const markers = document.createElement("span");
        const isPreview = scene.id === previewSceneId;
        const isProgram = scene.id === programSceneId;
        const states = [];

        button.type = "button";
        button.className = [
            "studio-scene-card",
            isPreview ? "is-preview" : "",
            isProgram ? "is-program" : ""
        ].filter(Boolean).join(" ");
        button.dataset.studioSceneId = scene.id;
        button.setAttribute("aria-pressed", String(isPreview));

        if (isPreview) {
            states.push("Preview");
        }

        if (isProgram) {
            states.push("Program");
        }

        button.setAttribute(
            "aria-label",
            [scene.name, scene.type, states.join(" and ")]
                .filter(Boolean)
                .join(", ")
        );

        name.className = "studio-scene-card__name";
        name.textContent = scene.name;

        type.className = "studio-scene-card__type";
        type.textContent = scene.type;

        markers.className = "studio-scene-card__markers";

        if (isPreview) {
            markers.appendChild(this.createMarker("PVW", "preview"));
        }

        if (isProgram) {
            markers.appendChild(this.createMarker("PGM", "program"));
        }

        button.append(name, type, markers);

        return button;
    }

    createMarker(label, variant) {
        const marker = document.createElement("span");
        marker.className = `studio-marker studio-marker--${variant}`;
        marker.textContent = label;
        return marker;
    }

}
