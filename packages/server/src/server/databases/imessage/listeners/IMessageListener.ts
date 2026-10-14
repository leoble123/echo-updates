import fs from "fs";
import { MultiFileWatcher } from "@server/lib/MultiFileWatcher";
import type { FileChangeEvent } from "@server/lib/MultiFileWatcher";
import { Loggable } from "@server/lib/logging/Loggable";
import { Sema } from "async-sema";
import { IMessageCache, IMessagePoller } from "../pollers";
import { MessageRepository } from "..";
import { waitMs } from "@server/helpers/utils";

export class IMessageListener extends Loggable {
    tag = "IMessageListener";

    stopped: boolean;

    filePaths: string[];

    watcher: MultiFileWatcher;

    repo: MessageRepository;

    processLock: Sema;

    pollers: IMessagePoller[];

    cache: IMessageCache;

    lastCheck = 0;

    // Echo: change detection that never drops a wake-up.
    /** A check is queued or running. */
    private checking = false;
    /** Something changed while a check ran: run again straight after. */
    private dirty = false;
    /** Size and mtime of the watched files at the last look, for the safety-net timer. */
    private fingerprint = "";
    private safetyNet: NodeJS.Timeout = null;

    constructor({ filePaths, repo, cache }: { filePaths: string[], repo: MessageRepository, cache: IMessageCache }) {
        super();

        this.filePaths = filePaths;
        this.repo = repo;
        this.pollers = [];
        this.cache = cache;
        this.stopped = false;
        this.processLock = new Sema(1);
    }

    stop() {
        this.stopped = true;
        if (this.safetyNet) clearInterval(this.safetyNet);
        this.safetyNet = null;
        this.removeAllListeners();
    }

    /** The watched files' sizes and times, cheaply - a change here means Messages wrote something. */
    private stamp(): string {
        return this.filePaths
            .map(f => {
                try {
                    const s = fs.statSync(f);
                    return `${s.size}:${s.mtimeMs}`;
                } catch {
                    return "-";
                }
            })
            .join("|");
    }

    addPoller(poller: IMessagePoller) {
        this.pollers.push(poller);
    }

    getEarliestModifiedDate() {
        let earliest = new Date();
        for (const filePath of this.filePaths) {
            const stat = fs.statSync(filePath);
            if (stat.mtime < earliest) {
                earliest = stat.mtime;
            }
        }

        return earliest;
    }

    async start() {
        this.lastCheck = this.getEarliestModifiedDate().getTime() - 60000;
        this.stopped = false;

        // Perform an initial poll to kinda seed the cache.
        // We'll use the earliest modified date of the files to determine the initial poll date.
        // We'll also subtract 1 minute just to pre-load the cache with a little bit of data.
        await this.poll(new Date(this.lastCheck), false);

        this.watcher = new MultiFileWatcher(this.filePaths);
        this.watcher.on("change", async (event: FileChangeEvent) => {
            await this.handleChangeEvent(event);
        });

        this.watcher.on("error", (error) => {
            this.log.error(`Failed to watch database files: ${this.filePaths.join(", ")}`);
            this.log.debug(`Error: ${error}`);
        });

        this.watcher.start();

        // macOS file events can arrive late or not at all for the WAL file; a
        // stat a second is nothing, and catches any write the watcher missed.
        this.fingerprint = this.stamp();
        this.safetyNet = setInterval(() => {
            if (this.stopped) return;
            const now = this.stamp();
            if (now !== this.fingerprint) this.requestCheck();
        }, 1000);
    }

    /**
     * A write happened. Waits a moment so a burst of writes (one message is
     * several) is read in one go, then checks. A write that lands while a
     * check is already running is never folded into it - that check may
     * already have read past it - but runs another check straight after.
     * The old debounce did fold it in, which is what held messages back
     * until the next one arrived and then delivered them all at once.
     */
    requestCheck() {
        if (this.stopped) return;
        if (this.checking) {
            this.dirty = true;
            return;
        }
        this.checking = true;
        setTimeout(() => this.runChecks(), 150);
    }

    private async runChecks() {
        try {
            do {
                this.dirty = false;
                this.fingerprint = this.stamp();
                await this.check();
            } while (this.dirty && !this.stopped);
        } finally {
            this.checking = false;
        }
    }

    async handleChangeEvent(_event: FileChangeEvent) {
        this.requestCheck();
    }

    private async check() {
        await this.processLock.acquire();
        try {
            const now = Date.now();
            let prevTime = this.lastCheck;
    
            if (prevTime <= 0 || prevTime > now) {
                this.log.debug(`Previous time is invalid (${prevTime}), setting to now...`);
                prevTime = now;
            } else if (now - prevTime > 86400000) {
                this.log.debug(`Previous time is > 24 hours ago, setting to 24 hours ago...`);
                prevTime = now - 86400000;
            }
    
            let afterTime = prevTime - 30000;
            if (afterTime > now) {
                afterTime = now;
            }
            await this.poll(new Date(afterTime));
            this.lastCheck = now;
    
            this.cache.trimCaches();
            if (this.processLock.nrWaiting() > 0) {
                await waitMs(100);
            }
        } catch (error) {
            this.log.error(`Error handling change event: ${error}`);
        } finally {
            this.processLock.release();
        }
    }

    async poll(after: Date, emitResults = true) {
        for (const poller of this.pollers) {
            const results = await poller.poll(after);

            if (emitResults) {
                for (const result of results) {
                    this.emit(result.eventType, result.data);
                    await waitMs(10);
                }
            }
        }
    }
}
