import PlaybackRuntime from "../runtime/PlaybackRuntime.js";
import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import BroadcastStateManager from "../core/BroadcastStateManager.js";
import StudioStateManager from "../core/StudioStateManager.js";
import BroadcastUI from "../ui/BroadcastUI.js";
import StudioUI from "../ui/StudioUI.js";
import StudioGraphicsUI from "../ui/StudioGraphicsUI.js";
import StudioTextCrawlUI from "../ui/StudioTextCrawlUI.js";
import StudioMediaUI from "../ui/StudioMediaUI.js";
import StudioOperationalSourcesUI from "../ui/StudioOperationalSourcesUI.js";
import ControlDeskLayoutManager from "../ui/ControlDeskLayoutManager.js";
import MonitorWallLayoutManager from "../ui/MonitorWallLayoutManager.js";
import ProgramFullscreenUI from "../ui/ProgramFullscreenUI.js";
import OverlayController from "../ui/OverlayController.js";
import NotificationCenter from "../ui/NotificationCenter.js";
import DebugPanel from "../debug/DebugPanel.js";
import StudioBootstrap from "../studio/StudioBootstrap.js";
import StudioCatalogManager from "../studio/StudioCatalogManager.js";
import StudioAssetLibrary from "../studio/StudioAssetLibrary.js";
import StudioAssetResolver from "../studio/StudioAssetResolver.js";
import StudioRenderer from "../studio/StudioRenderer.js";
import StudioSourceManager from "../studio/StudioSourceManager.js";
import StudioGraphicsManager from "../studio/StudioGraphicsManager.js";
import StudioTransitionCoordinator from "../studio/StudioTransitionCoordinator.js";
import createStudioRemovalGuard from "../studio/StudioRemovalGuard.js";
import ProgramOutputManager from "../program-output/ProgramOutputManager.js";
import ProgramOutputSetupUI from "../ui/ProgramOutputSetupUI.js";
import StudioScheduleSummaryUI from "../ui/StudioScheduleSummaryUI.js";
import ScheduleWorkspaceUI from "../ui/ScheduleWorkspaceUI.js";
import ScheduleClock from "../ui/ScheduleClock.js";
import ProgramRemainingTimeUI from "../ui/ProgramRemainingTimeUI.js";
import ScheduleStore from "../scheduler/ScheduleStore.js";
import SchedulerEngine from "../scheduler/SchedulerEngine.js";
import SchedulerRuntimeState from "../scheduler/SchedulerRuntimeState.js";
import StudioProgramCommand from "../scheduler/StudioProgramCommand.js";
import { createProgramOutputTransport } from
    "../program-output/ProgramOutputTransportFactory.js";
import LiveSourceMonitor from "../studio/LiveSourceMonitor.js";
import TechnicalLiveMonitorUI from "../ui/TechnicalLiveMonitorUI.js";
import DominantLiveConfig from "../studio/DominantLiveConfig.js";
import DominantLiveController from "../studio/DominantLiveController.js";
import DominantLiveUI from "../ui/DominantLiveUI.js";
import { createDominantLiveConsumerFactory } from
    "../studio/DominantLiveHealthConsumer.js";
import MediaLibraryClient from "../media-library/MediaLibraryClient.js";
import MediaLibraryManager from "../media-library/MediaLibraryManager.js";
import MediaLibraryUI from "../ui/MediaLibraryUI.js";
import MediaLibraryPickerUI from "../ui/MediaLibraryPickerUI.js";

BroadcastStateManager.initialize();
StudioStateManager.initialize();

const runtime = new PlaybackRuntime();
const studioAssetLibrary = new StudioAssetLibrary();
const mediaLibraryManager = new MediaLibraryManager(new MediaLibraryClient());
const studioAssetResolver = new StudioAssetResolver({
    legacyLibrary: studioAssetLibrary,
    mediaLibraryManager
});
const studioCatalogManager = new StudioCatalogManager({
    studioStateManager: StudioStateManager,
    studioSourceManager: StudioSourceManager,
    assetResolver: studioAssetResolver
});
const studioBootstrap = new StudioBootstrap({
    studioCatalogManager,
    studioGraphicsManager: StudioGraphicsManager
});
const dominantLiveConfig = new DominantLiveConfig();
let broadcastUI = null;
let studioUI = null;
let studioGraphicsUI = null;
let studioTextCrawlUI = null;
let studioMediaUI = null;
let studioSourcesUI = null;
let controlDeskLayoutManager = null;
let monitorWallLayoutManager = null;
let studioRenderer = null;
let studioTransitionCoordinator = null;
let programFullscreenUI = null;
let programOutputManager = null;
let programOutputSetupUI = null;
let studioScheduleUI = null;
let scheduleWorkspaceUI = null;
let schedulerEngine = null;
let programRemainingTimeUI = null;
let technicalLiveMonitorUI = null;
let dominantLiveController = null;
let dominantLiveUI = null;
let mediaLibraryUI = null;
let mediaLibraryPickerUI = null;

function destroyControlRoom() {
    studioTextCrawlUI?.destroy();
    studioTextCrawlUI = null;
    studioGraphicsUI?.destroy();
    studioGraphicsUI = null;
    mediaLibraryUI?.destroy();
    mediaLibraryPickerUI?.destroy();
    studioSourcesUI?.destroy();
    studioSourcesUI = null;
    studioUI?.destroy();
    studioUI = null;
}

EventBus.on(Events.ENGINE_STOP, destroyControlRoom);

runtime.start({
    startPlayer: false,
    async beforePlayerStart(config) {
        broadcastUI = new BroadcastUI();
        broadcastUI.start(config);

        StudioSourceManager.initialize(config);
        StudioGraphicsManager.initialize();

        const assetLibraryReport = await studioAssetLibrary.initialize();

        if (assetLibraryReport.status !== "ready") {
            console.warn("[StudioAssetLibrary]", assetLibraryReport);
        }

        try { await mediaLibraryManager.initialize(); }
        catch (error) { console.warn("[MediaLibraryManager]", error); }

        const bootstrapReport = await studioBootstrap.initialize();

        if (bootstrapReport.status !== "ready") {
            console.warn("[StudioBootstrap]", bootstrapReport);
        }

        studioRenderer = new StudioRenderer({
            previewRoot: document.getElementById("studio-preview-renderer"),
            programRoot: document.getElementById("studio-program-renderer"),
            studioStateManager: StudioStateManager,
            definitionRegistry: studioCatalogManager,
            studioSourceManager: StudioSourceManager,
            studioGraphicsManager: StudioGraphicsManager
        });
        studioRenderer.start();

        studioTransitionCoordinator = new StudioTransitionCoordinator({
            studioStateManager: StudioStateManager,
            studioRenderer
        });
        studioTransitionCoordinator.start();
        const programOutputTransport = await createProgramOutputTransport({
            role: "publisher"
        });
        programOutputManager = new ProgramOutputManager({
            stateManager: StudioStateManager,
            catalog: studioCatalogManager,
            sourceManager: StudioSourceManager,
            renderer: studioRenderer,
            graphicsManager: StudioGraphicsManager,
            transitionCoordinator: studioTransitionCoordinator,
            transport: programOutputTransport
        });
        programOutputManager.start();
        programOutputSetupUI = new ProgramOutputSetupUI({
            root: document,
            transport: programOutputTransport
        });
        programOutputSetupUI.start();
        const scheduleStore = new ScheduleStore();
        studioCatalogManager.setRemovalGuard(createStudioRemovalGuard({
            dominantLiveConfig,
            transitionCoordinator: studioTransitionCoordinator,
            studioRenderer,
            scheduleStore
        }));

        studioUI = new StudioUI(
            document.getElementById("studio-panel"),
            studioTransitionCoordinator,
            studioCatalogManager
        );
        studioUI.start();

        const studioProgramCommand = new StudioProgramCommand({
            stateManager: StudioStateManager,
            catalog: studioCatalogManager,
            transitionCoordinator: studioTransitionCoordinator
        });
        schedulerEngine = new SchedulerEngine({
            command: studioProgramCommand,
            catalog: studioCatalogManager,
            programTransportProvider: () => studioRenderer.getProgramTransport(),
            runtimeState: new SchedulerRuntimeState()
        });
        const scheduleClock = new ScheduleClock();
        studioScheduleUI = new StudioScheduleSummaryUI({
            root: document,
            engine: schedulerEngine,
            store: scheduleStore,
            catalog: studioCatalogManager,
            clockTicker: scheduleClock
        });
        studioScheduleUI.start();
        schedulerEngine.restoreEnabledState();
        scheduleWorkspaceUI = new ScheduleWorkspaceUI({
            root: document.getElementById("control-schedule-view"),
            store: scheduleStore,
            catalog: studioCatalogManager,
            clockTicker: scheduleClock,
            readOnly: true,
            editorUrl: "./schedule/"
        });
        scheduleWorkspaceUI.start();
        programRemainingTimeUI = new ProgramRemainingTimeUI({
            root: document,
            schedulerEngine,
            renderer: studioRenderer,
            stateManager: StudioStateManager
        });
        programRemainingTimeUI.start();

        studioMediaUI = new StudioMediaUI(
            document.getElementById("studio-panel"),
            studioRenderer
        );
        studioMediaUI.start();

        mediaLibraryPickerUI = new MediaLibraryPickerUI(mediaLibraryManager);
        mediaLibraryPickerUI.start();
        studioSourcesUI = new StudioOperationalSourcesUI(
            document.getElementById("studio-panel"), studioCatalogManager,
            { mediaLibraryManager, mediaLibraryPicker: mediaLibraryPickerUI }
        );
        studioSourcesUI.start();
        mediaLibraryUI = new MediaLibraryUI(
            document.getElementById("media-library"),
            mediaLibraryManager
        );
        mediaLibraryUI.start();

        const technicalRoot = document.querySelector(".control-room-technical");
        const liveSourceMonitor = new LiveSourceMonitor({
            consumerFactory: TechnicalLiveMonitorUI.createConsumerFactory(
                technicalRoot.querySelector("#technical-live-surface")
            )
        });
        technicalLiveMonitorUI = new TechnicalLiveMonitorUI({
            root: technicalRoot, catalog: studioCatalogManager,
            monitor: liveSourceMonitor
        });
        technicalLiveMonitorUI.start();

        const dominantHealthSurface = document.createElement("div");
        dominantHealthSurface.className = "dominant-live-health-surface";
        dominantHealthSurface.setAttribute("aria-hidden", "true");
        document.body.append(dominantHealthSurface);
        let dominantProbeDiagnostics = Object.freeze({});
        const dominantHealthMonitor = new LiveSourceMonitor({
            consumerFactory: createDominantLiveConsumerFactory(
                dominantHealthSurface,
                (diagnostics) => {
                    dominantProbeDiagnostics = diagnostics;
                    dominantLiveController?.refreshDiagnostics();
                }
            )
        });
        dominantLiveController = new DominantLiveController({
            config: dominantLiveConfig,
            catalog: studioCatalogManager,
            monitor: dominantHealthMonitor,
            scheduler: schedulerEngine,
            command: studioProgramCommand,
            probeDiagnosticsProvider: () => dominantProbeDiagnostics
        });
        dominantLiveController.start();
        dominantLiveUI = new DominantLiveUI({
            root: document.getElementById("dominant-live-control"),
            config: dominantLiveConfig,
            controller: dominantLiveController
        });
        dominantLiveUI.start();

        studioGraphicsUI = new StudioGraphicsUI(
            document.getElementById("studio-panel"),
            StudioGraphicsManager,
            "lower-third-basic",
            studioAssetLibrary
        );
        studioGraphicsUI.start();
        studioTextCrawlUI = new StudioTextCrawlUI({
            root: document.getElementById("studio-panel"),
            graphicsManager: StudioGraphicsManager
        });
        studioTextCrawlUI.start();

        studioAssetLibrary.setReferenceGuard((asset) =>
            studioCatalogManager.isAssetReferenced(asset.id) ||
            studioGraphicsUI.isAssetReferenced(asset)
                ? "asset-still-referenced"
                : null
        );
        monitorWallLayoutManager = new MonitorWallLayoutManager({
            root: document.querySelector(".control-room-monitor-wall")
        });
        monitorWallLayoutManager.start();

        controlDeskLayoutManager = new ControlDeskLayoutManager({
            root: document.getElementById("studio-panel"),
            onEditModeChange: (enabled) =>
                monitorWallLayoutManager?.setEditMode(enabled),
            onReset: () => monitorWallLayoutManager?.reset()
        });
        controlDeskLayoutManager.start();

        programFullscreenUI = new ProgramFullscreenUI({
            target: document.querySelector(".control-room-program"),
            button: document.getElementById("program-fullscreen-toggle")
        });
        programFullscreenUI.start();

        new OverlayController();
        new NotificationCenter();
    }
}).then(({ player }) => {
    const debugContainer = document.getElementById("debug-panel");

    if (!debugContainer || !player) {
        return;
    }

    const debugPanel = new DebugPanel(debugContainer);
    debugPanel.render();
    debugPanel.attach(player);
}).catch(() => {
    // PlaybackRuntime already reports the startup failure to the UI/EventBus.
});
