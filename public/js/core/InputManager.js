/**
 * LIVEZONE Broadcast Engine
 * ------------------------------------------------------------
 * File: public/js/core/InputManager.js
 * Version: 12.1.1-alpha
 *
 * Unified Pointer Input Manager
 * Desktop + Mobile + Pen
 * ------------------------------------------------------------
 */

export default class InputManager {

    constructor(target) {

        this.target = target;

        this.handlers = {};

        this.dragging = false;

        this.pointerId = null;

        this.startX = 0;
        this.startY = 0;

        this.lastX = 0;
        this.lastY = 0;

        this.longPressTimer = null;

        this.lastTap = 0;

        this._bind();

    }

    on(event, callback) {

        if (!this.handlers[event]) {
            this.handlers[event] = [];
        }

        this.handlers[event].push(callback);

        return this;

    }

    off(event, callback) {

        if (!this.handlers[event]) return;

        this.handlers[event] =
            this.handlers[event].filter(fn => fn !== callback);

    }

    emit(event, payload = {}) {

        if (!this.handlers[event]) return;

        this.handlers[event].forEach(fn => fn(payload));

    }

    destroy() {

        this.target.removeEventListener("pointerdown", this._pointerDown);
        window.removeEventListener("pointermove", this._pointerMove);
        window.removeEventListener("pointerup", this._pointerUp);
        window.removeEventListener("pointercancel", this._pointerUp);

        clearTimeout(this.longPressTimer);

        this.handlers = {};

    }

    _bind() {

        this._pointerDown = this._onPointerDown.bind(this);
        this._pointerMove = this._onPointerMove.bind(this);
        this._pointerUp = this._onPointerUp.bind(this);

        this.target.style.touchAction = "none";

        this.target.addEventListener(
            "pointerdown",
            this._pointerDown,
            { passive: false }
        );

        window.addEventListener(
            "pointermove",
            this._pointerMove,
            { passive: false }
        );

        window.addEventListener(
            "pointerup",
            this._pointerUp,
            { passive: false }
        );

        window.addEventListener(
            "pointercancel",
            this._pointerUp,
            { passive: false }
        );

    }

    _onPointerDown(e) {

        this.pointerId = e.pointerId;

        this.dragging = true;

        this.startX = e.clientX;
        this.startY = e.clientY;

        this.lastX = e.clientX;
        this.lastY = e.clientY;

        this.target.setPointerCapture?.(e.pointerId);

        this.emit("dragstart", {
            x: e.clientX,
            y: e.clientY,
            originalEvent: e
        });

        clearTimeout(this.longPressTimer);

        this.longPressTimer = setTimeout(() => {

            if (!this.dragging) return;

            this.emit("longpress", {
                x: this.lastX,
                y: this.lastY,
                originalEvent: e
            });

        }, 600);

    }

    _onPointerMove(e) {

        if (!this.dragging) return;

        if (e.pointerId !== this.pointerId) return;

        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;

        this.lastX = e.clientX;
        this.lastY = e.clientY;

        this.emit("drag", {
            x: e.clientX,
            y: e.clientY,
            dx,
            dy,
            originalEvent: e
        });

    }

    _onPointerUp(e) {

        if (!this.dragging) return;

        if (e.pointerId !== this.pointerId) return;

        clearTimeout(this.longPressTimer);

        this.dragging = false;

        this.emit("dragend", {
            x: e.clientX,
            y: e.clientY,
            originalEvent: e
        });

        const now = Date.now();

        if (now - this.lastTap < 300) {

            this.emit("doubletap", {
                x: e.clientX,
                y: e.clientY,
                originalEvent: e
            });

            this.lastTap = 0;

        } else {

            this.emit("tap", {
                x: e.clientX,
                y: e.clientY,
                originalEvent: e
            });

            this.lastTap = now;

        }

        this.pointerId = null;

    }

}