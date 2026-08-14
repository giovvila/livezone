import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import StudioStateManager from "../core/StudioStateManager.js";

export default class StudioUI {

    constructor(root, transitionCoordinator) {
        this.root = root;
        this.transitionCoordinator = transitionCoordinator;
        this.started = false;

        this.handleToggleClick = this.handleToggleClick.bind(this);
        this.handleCloseClick = this.handleCloseClick.bind(this);
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

        this.main = this.root.closest(".main");
        this.toggle = document.getElementById("studio-toggle");
        this.closeButton = this.root.querySelector("#studio-close");
        this.sceneList = this.root.querySelector("#studio-scene-list");
        this.emptyState = this.root.querySelector("#studio-empty-state");
        this.previewScene = this.root.querySelector("#studio-preview-scene");
        this.programScene = this.root.querySelector("#studio-program-scene");
        this.takeButton = this.root.querySelector("#studio-take");
        this.transitionSelect = this.root.querySelector(
            "#studio-transition-type"
        );

        if (
            !this.main || !this.toggle || !this.closeButton ||
            !this.sceneList || !this.emptyState || !this.previewScene ||
            !this.programScene || !this.takeButton || !this.transitionSelect ||
            !this.transitionCoordinator
        ) {
            return;
        }

        this.toggle.addEventListener("click", this.handleToggleClick);
        this.closeButton.addEventListener("click", this.handleCloseClick);
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

        this.setOpen(false);
        this.renderFromState();
        this.started = true;
    }

    destroy() {
        if (!this.started) {
            return;
        }

        this.toggle.removeEventListener("click", this.handleToggleClick);
        this.closeButton.removeEventListener("click", this.handleCloseClick);
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

        this.setOpen(false);
        this.started = false;
        this.studioEvents = null;
        this.unsubscribeTransition = null;
        this.main = null;
        this.toggle = null;
        this.closeButton = null;
        this.sceneList = null;
        this.emptyState = null;
        this.previewScene = null;
        this.programScene = null;
        this.takeButton = null;
        this.transitionSelect = null;
        this.selectedTransition = null;
    }

    handleToggleClick() {
        this.setOpen(this.root.hidden);
    }

    handleCloseClick() {
        this.setOpen(false);
        this.toggle.focus();
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

    setOpen(isOpen) {
        this.root.hidden = !isOpen;
        this.toggle.setAttribute("aria-expanded", String(isOpen));
        this.main.classList.toggle("main--studio-open", isOpen);
    }

    renderFromState() {
        const scenes = StudioStateManager.getScenes();
        const previewSceneId = StudioStateManager.getPreviewSceneId();
        const programSceneId = StudioStateManager.getProgramSceneId();
        const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));

        this.sceneList.replaceChildren();

        scenes.forEach((scene) => {
            this.sceneList.appendChild(
                this.createSceneButton(scene, previewSceneId, programSceneId)
            );
        });

        this.emptyState.hidden = scenes.length !== 0;

        const preview = sceneById.get(previewSceneId) || null;
        const program = sceneById.get(programSceneId) || null;

        this.renderSceneSummary(this.previewScene, preview);
        this.renderSceneSummary(this.programScene, program);

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

        button.type = "button";
        button.className = "studio-scene-card";
        button.dataset.studioSceneId = scene.id;
        button.setAttribute("aria-pressed", String(isPreview));

        name.className = "studio-scene-card__name";
        name.textContent = scene.name;

        type.className = "studio-scene-card__type";
        type.textContent = scene.type;

        markers.className = "studio-scene-card__markers";

        if (isPreview) {
            markers.appendChild(this.createMarker("PREVIEW", "preview"));
        }

        if (isProgram) {
            markers.appendChild(this.createMarker("PROGRAM", "program"));
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

    renderSceneSummary(element, scene) {
        element.replaceChildren();

        if (!scene) {
            element.textContent = "—";
            return;
        }

        const name = document.createElement("strong");
        const type = document.createElement("span");

        name.textContent = scene.name;
        type.textContent = scene.type;
        element.append(name, type);
    }
}
