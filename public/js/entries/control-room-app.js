import { shareTechnicalLiveHealth } from "../studio/SharedLiveHealthConsumer.js";
import AutoLiveEntryPresentation from "../studio/AutoLiveEntryPresentation.js";
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
import { programPlaybackContinuity } from "../studio/ProgramPlaybackContinuity.js";
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
import ScheduleTargetResolver from "../scheduler/ScheduleTargetResolver.js";
import { createProgramOutputTransport } from
    "../program-output/ProgramOutputTransportFactory.js";
import LiveSourceMonitor from "../studio/LiveSourceMonitor.js";
import TechnicalLiveMonitorUI from "../ui/TechnicalLiveMonitorUI.js";
import DominantLiveConfig from "../studio/DominantLiveConfig.js";
import AutoLiveEntryController from "../studio/AutoLiveEntryController.js";
import DominantLiveUI from "../ui/DominantLiveUI.js";
import SourcePresenceMonitor from "../studio/SourcePresenceMonitor.js";
import { createLiveHlsConsumerFactory } from "../studio/LiveHlsHealthConsumer.js";
import MediaLibraryClient from "../media-library/MediaLibraryClient.js";
import MediaLibraryManager from "../media-library/MediaLibraryManager.js";
import MediaLibraryUI from "../ui/MediaLibraryUI.js";
import MediaLibraryPickerUI from "../ui/MediaLibraryPickerUI.js";
import { requireOperatorSession } from "../auth/OperatorSessionClient.js";
import OperatorSessionUI from "../ui/OperatorSessionUI.js";

await requireOperatorSession();
const operatorSessionUI = new OperatorSessionUI(
    document.getElementById("operator-logout"));
operatorSessionUI.start();

// Back/forward cache restores frozen JS instead of running the bootstrap again.
// Re-enter through retained Program Output so elapsed Scheduler time is applied.
globalThis.addEventListener?.("pageshow", event => {
    if (event.persisted) globalThis.location.reload();
});

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
let autoLiveLossPresentation = null;
let dominantLiveUI = null;
let mediaLibraryUI = null;
let mediaLibraryPickerUI = null;

// The Control Desk is static page markup. Start its interaction layer before
// optional runtime services so Reset Layout and compact defaults remain usable
// if a later media, transport, or monitoring bootstrap step cannot start.
controlDeskLayoutManager = new ControlDeskLayoutManager({
    root: document.getElementById("studio-panel"),
    onEditModeChange: (enabled) =>
        monitorWallLayoutManager?.setEditMode(enabled),
    onReset: () => monitorWallLayoutManager?.reset()
});
controlDeskLayoutManager.start();

function destroyControlRoom() {
    dominantLiveController?.destroy();
    dominantLiveController = null;
    autoLiveLossPresentation?.destroy();
    autoLiveLossPresentation = null;
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
        dominantLiveConfig.logRead(studioCatalogManager);

        if (bootstrapReport.status !== "ready") {
            console.warn("[StudioBootstrap]", bootstrapReport);
        }

        const programOutputTransport = await createProgramOutputTransport({ role: "publisher" });
        const retainedProgram = await programOutputTransport.readRetained();
        const initialProgramContext = programPlaybackContinuity(retainedProgram, {
            stateManager: StudioStateManager, catalog: studioCatalogManager,
            sourceManager: StudioSourceManager
        });
        studioRenderer = new StudioRenderer({
            previewRoot: document.getElementById("studio-preview-renderer"),
            programRoot: document.getElementById("studio-program-renderer"),
            studioStateManager: StudioStateManager,
            definitionRegistry: studioCatalogManager,
            studioSourceManager: StudioSourceManager,
            studioGraphicsManager: StudioGraphicsManager,
            initialProgramContext
        });
        studioRenderer.start();

        studioTransitionCoordinator = new StudioTransitionCoordinator({
            studioStateManager: StudioStateManager,
            studioRenderer
        });
        studioTransitionCoordinator.start();
        programOutputManager = new ProgramOutputManager({
            stateManager: StudioStateManager,
            catalog: studioCatalogManager,
            sourceManager: StudioSourceManager,
            renderer: studioRenderer,
            graphicsManager: StudioGraphicsManager,
            transitionCoordinator: studioTransitionCoordinator,
            transport: programOutputTransport,
            initialProgramContext
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
            studioCatalogManager,
            () => Boolean(programOutputManager?.pendingProgramPublishReason)
        );
        studioUI.start();

        const scheduleTargetResolver = new ScheduleTargetResolver({
            catalog: studioCatalogManager
        });
        const dominantLiveTargetResolver = new ScheduleTargetResolver({
            catalog: studioCatalogManager,
            namespace: "dominant-live-source"
        });
        const studioProgramCommand = new StudioProgramCommand({
            stateManager: StudioStateManager,
            catalog: studioCatalogManager,
            transitionCoordinator: studioTransitionCoordinator,
            targetResolver: scheduleTargetResolver
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
            editorUrl: "./schedule/",
            schedulerEngine
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

        const dominantHealthRoot = document.createElement("div");
        dominantHealthRoot.className = "dominant-live-health-surface";
        dominantHealthRoot.setAttribute("aria-hidden", "true");
        document.body.append(dominantHealthRoot);
        const dominantHealthMonitor = new SourcePresenceMonitor({
            externalConsumerFactory: shareTechnicalLiveHealth(liveSourceMonitor,
                createLiveHlsConsumerFactory(dominantHealthRoot))
        });
        dominantLiveController = new AutoLiveEntryController({
            renderer: studioRenderer,
            getProgramRevision: () => programOutputManager?.revision,
            config: dominantLiveConfig,
            catalog: studioCatalogManager,
            monitor: dominantHealthMonitor,
            scheduler: schedulerEngine,
            command: studioProgramCommand,
            targetResolver: dominantLiveTargetResolver,
            probeDiagnosticsProvider: () => ({ healthAuthority: "source" })
        });
        dominantLiveController.start();
        autoLiveLossPresentation = new AutoLiveEntryPresentation({
            controller: dominantLiveController, output: programOutputManager, renderer: studioRenderer,
            root: studioRenderer.program.root, stateManager: StudioStateManager
        });
        autoLiveLossPresentation.start();
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
