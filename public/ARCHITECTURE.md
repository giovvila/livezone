# LIVEZONE Broadcast Engine

Version: 1.0
Status: Development

---

# Vision

LIVEZONE Broadcast Engine è una piattaforma modulare per la gestione di una Web TV professionale.

L'obiettivo non è creare un semplice player HLS ma un vero Broadcast Engine capace di gestire:

- Live Streaming
- VOD
- Playlist
- Overlay
- Branding
- Palinsesto
- Multicanale
- Dashboard tecnica
- Regia Broadcast

---

# Design Principles

## Una responsabilità per componente

Ogni modulo deve fare una sola cosa.

Esempi:

AdaptivePlayer
↓

Ridimensiona il player

OverlayManager
↓

Gestisce gli overlay

NotificationCenter
↓

Gestisce le notifiche

Mai componenti che fanno più cose.

---

## Layout indipendente

La logica non deve dipendere dalla posizione degli elementi nella pagina.

Il player deve poter funzionare:

- Embedded
- Fullscreen
- Kiosk
- Dashboard
- Multiview

senza modifiche.

---

## Event Driven

I moduli comunicano tramite EventBus.

Mai chiamate dirette quando possono essere sostituite da eventi.

Esempio:

STREAM_ONLINE

↓

Overlay

↓

Status Bar

↓

Watermark

↓

Statistics

---

# Directory Structure

public/

css/

layout.css

player.css

branding.css

status.css

ticker.css

theme.css

js/

core/

components/

services/

config/

assets/

logo/

icons/

overlays/

backgrounds/

data/

schedule.json

ticker.json

channels.json

---

# Core Components

AdaptivePlayer

Ridimensionamento automatico del player.

PlayerController

Controllo del player HTML5 / HLS.

StreamMonitor

Monitoraggio dello stato dello stream.

OverlayManager

Gestione overlay.

BrandManager

Gestione branding.

NotificationCenter

Gestione notifiche.

---

# Future Components

BroadcastPanel

ProgramManager

Scheduler

SceneManager

MediaLibrary

EmergencyOverlay

AnalyticsEngine

HealthMonitor

EPGManager

---

# EventBus

STREAM_CONNECTING

STREAM_ONLINE

STREAM_OFFLINE

STREAM_ERROR

PLAYER_READY

PLAYER_FULLSCREEN

PLAYER_RESIZE

OVERLAY_SHOW

OVERLAY_HIDE

NOTIFICATION_SHOW

NOTIFICATION_HIDE

---

# CSS Architecture

layout.css

↓

Solo layout

player.css

↓

Solo player

branding.css

↓

Solo branding

status.css

↓

Solo status bar

ticker.css

↓

Solo ticker

theme.css

↓

Variabili

Colori

Animazioni

Shadow

Glow

---

# Build Rules

Ogni Build deve:

- essere testabile
- avere un commit dedicato
- non rompere le build precedenti
- avere una sola responsabilità

---

# Current Roadmap

BUILD 1005

Refactoring CSS

BUILD 1006

Broadcast Player

BUILD 1007

Broadcast Engine

BUILD 1008

Regia

BUILD 1009

Palinsesto

BUILD 1010

Dashboard

---

# Long Term Goal

Creare un Broadcast Engine professionale, modulare e scalabile, utilizzabile come base per:

- emittenti televisive
- radio
- eventi live
- IPTV
- digital signage
- canali tematici
