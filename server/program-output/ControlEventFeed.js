// Multiplex existing authorities on the authenticated reference-presence response.
// No state merge, revisions, scheduler clock or authority is introduced here.
export default class ControlEventFeed {
    constructor({effectiveOutput, scheduler, autoLive = null}) {
        Object.assign(this, {effectiveOutput, scheduler, autoLive});
        this.clients = new Set();
        this.offProgram = effectiveOutput.subscribe(value => this.broadcast('program', value));
        this.offSchedule = scheduler.subscribe(value => this.broadcast('schedule-state', value));
        this.offAutoLive = autoLive?.subscribe(value => this.broadcast('autolive-state', value));
    }

    connect(response) {
        if (this.closed) { response.end(); return () => {}; }
        this.clients.add(response);
        const schedule = this.scheduler.current();
        const program = this.effectiveOutput.getCurrent();
        if (program) this.write(response, 'program', program);
        this.write(response, 'schedule-state', schedule);
        if(this.autoLive?.runtime)this.write(response,'autolive-state',this.autoLive.current());
        else if(this.autoLive)void this.autoLive.ready.then(()=>{
            if(!this.closed&&this.clients.has(response))this.write(response,'autolive-state',this.autoLive.current());
        });
        return () => this.clients.delete(response);
    }

    broadcast(type, value) {
        for (const response of this.clients) this.write(response, type, value);
    }

    write(response, type, value) {
        if (response.destroyed || response.writableEnded) { this.clients.delete(response); return; }
        try {
            if (!response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)) response.destroy();
        } catch { response.destroy(); }
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.offProgram();
        this.offSchedule();
        this.offAutoLive?.();
        for (const response of this.clients) response.end();
        this.clients.clear();
    }
}
