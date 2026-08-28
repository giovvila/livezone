import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import StudioStateManager from "../core/StudioStateManager.js";

export default class StudioUI {

    constructor(root, transitionCoordinator, catalog = null) {
        this.root = root;
        this.transitionCoordinator = transitionCoordinator;
        this.catalog = catalog;
        this.started = false;

        this.handleSceneListClick = this.handleSceneListClick.bind(this);
        this.handleTakeClick = this.handleTakeClick.bind(this);
        this.handleTransitionChange = this.handleTransitionChange.bind(this);
        this.renderFromState = this.renderFromState.bind(this);
        this.handleSceneCreate = this.handleSceneCreate.bind(this);
        this.handleSceneFormOpen = this.handleSceneFormOpen.bind(this);
        this.handleSceneFormCancel = this.handleSceneFormCancel.bind(this);
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

        if (this.catalog) {
            this.sceneForm = this.createSceneForm();
            this.sceneList.before(this.sceneForm.button, this.sceneForm.form, this.sceneForm.feedback);
            this.sceneForm.form.addEventListener("submit", this.handleSceneCreate);
            this.unsubscribeSources = this.catalog.subscribe((sources) => {
                this.availableSources = sources.filter((source) => source.enabled !== false);
                this.renderSceneSourceOptions();
                this.renderFromState();
            });
        }

        this.studioEvents = [
            Events.STUDIO_SCENE_REGISTERED,
            Events.STUDIO_SCENE_UPDATED,
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
            return false;
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
        this.unsubscribeSources?.();
        this.sceneForm?.form.removeEventListener("submit", this.handleSceneCreate);
        this.sceneForm?.button.removeEventListener("click", this.handleSceneFormOpen);
        this.sceneForm?.cancelButton.removeEventListener("click", this.handleSceneFormCancel);
        this.sceneForm?.button.remove();
        this.sceneForm?.form.remove();
        this.sceneForm?.feedback.remove();

        this.started = false;
        this.studioEvents = null;
        this.unsubscribeTransition = null;
        this.unsubscribeSources = null;
        this.sceneForm = null;
        this.availableSources = null;
        this.editingSceneId = null;
        this.sceneList = null;
        this.emptyState = null;
        this.takeButton = null;
        this.transitionSelect = null;
        this.selectedTransition = null;
        return true;
    }

    handleSceneListClick(event) {
        const action = event.target.closest("[data-scene-action]");
        if (action) {
            const sceneId = action.dataset.sceneId;
            const scene = StudioStateManager.getScene(sceneId);
            const definition = this.catalog?.getDefinition(sceneId);
            if (action.dataset.sceneAction === "edit" && scene && definition) {
                this.editingSceneId = sceneId;
                this.sceneForm.form.elements.name.value = scene.name;
                this.sceneForm.form.elements.sourceId.value =
                    definition.renderer.kind === "source" ? definition.renderer.sourceId : "";
                this.sceneForm.form.hidden = false;
                this.sceneForm.form.elements.name.focus();
            }
            else if (action.dataset.sceneAction === "delete") {
                const result = this.catalog.removeScene(sceneId);
                this.setSceneFeedback(result);
            }
            return;
        }
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

    handleSceneFormOpen() {
        this.sceneForm.form.hidden = false;
        this.sceneForm.form.elements.name.focus();
    }

    handleSceneFormCancel() {
        this.editingSceneId = null;
        this.sceneForm.form.hidden = true;
    }

    createSceneForm() {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "studio-scene-add";
        button.textContent = "+ CREATE SCENE";
        const form = document.createElement("form");
        form.className = "studio-scene-create-form";
        form.hidden = true;
        form.innerHTML = `<label>SCENE NAME<input name="name" maxlength="120" required></label><label>SOURCE<select name="sourceId" required></select></label><div><button type="submit">CREATE</button><button type="button" data-scene-cancel>CANCEL</button></div>`;
        const feedback = document.createElement("p");
        feedback.className = "studio-sources__feedback";
        const cancelButton = form.querySelector("[data-scene-cancel]");
        button.addEventListener("click", this.handleSceneFormOpen);
        cancelButton.addEventListener("click", this.handleSceneFormCancel);
        return { button, form, feedback, cancelButton };
    }

    renderSceneSourceOptions() {
        if (!this.sceneForm) return;
        const select = this.sceneForm.form.elements.sourceId;
        const groups = ["live", "video", "audio", "image"].map((kind) => {
            const group = document.createElement("optgroup");
            group.label = kind.toUpperCase();
            (this.availableSources || []).filter((source) => source.category === kind).forEach((source) => {
                const option = document.createElement("option");
                option.value = source.id;
                option.textContent = `${kind.toUpperCase()} — ${source.name}`;
                group.append(option);
            });
            return group;
        });
        select.replaceChildren(...groups);
    }

    handleSceneCreate(event) {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(this.sceneForm.form));
        const result = this.editingSceneId
            ? this.catalog.updateScene(this.editingSceneId, data)
            : this.catalog.createSceneForSource(data.sourceId, { name: data.name });
        this.setSceneFeedback(result, this.editingSceneId ? "Scene updated." : "Scene created.");
        if (result.ok) {
            this.editingSceneId = null;
            this.sceneForm.form.reset();
            this.sceneForm.form.hidden = true;
        }
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
        const row = document.createElement("div");
        const button = document.createElement("button");
        const name = document.createElement("span");
        const type = document.createElement("span");
        const markers = document.createElement("span");
        const supporting = document.createElement("span");
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
        const definition = this.catalog?.getDefinition(scene.id);
        const sourceId = definition?.renderer?.kind === "source"
            ? definition.renderer.sourceId
            : null;
        const source = sourceId
            ? (this.availableSources || []).find((item) => item.id === sourceId)
            : null;
        type.textContent = source?.category?.toUpperCase() || scene.type;

        supporting.className = "studio-scene-card__supporting";
        supporting.textContent = source
            ? `${source.name} · ${source.id}`
            : definition?.renderer?.kind === "slate"
                ? "SLATE · BUILT-IN"
                : scene.id;

        markers.className = "studio-scene-card__markers";

        if (isPreview) {
            markers.appendChild(this.createMarker("PVW", "preview"));
        }

        if (isProgram) {
            markers.appendChild(this.createMarker("PGM", "program"));
        }

        button.append(name, type, supporting, markers);
        row.className = "studio-scene-row";
        const actions = document.createElement("details");
        actions.className = "studio-item-actions studio-scene-actions";
        const summary = document.createElement("summary");
        summary.textContent = "⋯";
        summary.setAttribute("aria-label", `Manage ${scene.name}`);
        const menu = document.createElement("div");
        menu.append(this.createSceneAction("EDIT", "edit", scene.id),
            this.createSceneAction("DELETE", "delete", scene.id));
        actions.append(summary, menu);
        row.append(button, actions);

        return row;
    }

    createSceneAction(label, action, sceneId) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.dataset.sceneAction = action;
        button.dataset.sceneId = sceneId;
        return button;
    }

    setSceneFeedback(result, success = "Scene removed.") {
        const messages = { "scene-in-preview": "Scene is currently in Preview.",
            "scene-in-program": "Scene is currently in Program.",
            "scene-authorized": "Scene is referenced by Scheduler or an active runtime.",
            "source-not-found": "Choose an available source.",
            "invalid-name": "Enter a valid scene name.",
            "persistence-failed": "Scene registry could not be saved." };
        this.sceneForm.feedback.textContent = result.ok ? success :
            messages[result.reason] || "Scene operation rejected.";
        this.sceneForm.feedback.classList.toggle("is-error", !result.ok);
    }

    createMarker(label, variant) {
        const marker = document.createElement("span");
        marker.className = `studio-marker studio-marker--${variant}`;
        marker.textContent = label;
        return marker;
    }

}
